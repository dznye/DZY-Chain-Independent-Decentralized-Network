//! The Dznye exchange's vault on Solana (chain/EXCHANGE.md).
//!
//! It holds SOL and tokens (USDC) for people who bought DZY with them, and pays out only on proof that a sell-back
//! happened on Dznye: a release signed by validators holding more than two thirds of the current validator set's power.
//! The signatures are Ed25519 (every Dznye key is one), checked by Solana's own Ed25519 program in the same transaction;
//! this program reads them through the instructions sysvar. Each payout is paid once (an account marks it paid). There
//! is no admin: the validator set changes only by the current set's own signatures. Every signed message names this
//! program and the current set, so a signature is good nowhere else.
//!
//! Accounts (program-derived): config ["config"] (the validator set), vault ["vault"] (holds SOL; owns the token
//! accounts), released ["released", id] (exists once that payout is paid).
use solana_program::{
	account_info::{next_account_info, AccountInfo},
	entrypoint::ProgramResult,
	hash::hashv,
	instruction::{AccountMeta, Instruction},
	msg,
	program::{invoke, invoke_signed},
	program_error::ProgramError,
	pubkey::Pubkey,
	rent::Rent,
	system_instruction, system_program,
	sysvar::{instructions as ixs, Sysvar},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process);

pub const MAX_SIGNERS: usize = 32;
/// set id (8) + total power (8) + count (1) + up to 32 x (key 32 + power 8)
pub const CONFIG_SIZE: usize = 8 + 8 + 1 + MAX_SIGNERS * 40;
pub const ED25519_PROGRAM: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const TOKEN_PROGRAM: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

fn fail(why: &str) -> ProgramError { msg!("refused: {}", why); ProgramError::Custom(1) }

/// the validator set as stored in the config account
pub struct Set { pub id: u64, pub total: u64, pub keys: Vec<([u8; 32], u64)> }

impl Set {
	fn read(data: &[u8]) -> Result<Set, ProgramError> {
		if data.len() < CONFIG_SIZE { return Err(fail("not a config account")); }
		let id = u64::from_le_bytes(data[0..8].try_into().unwrap());
		let total = u64::from_le_bytes(data[8..16].try_into().unwrap());
		let n = data[16] as usize;
		if n == 0 || n > MAX_SIGNERS { return Err(fail("no validator set")); }
		let mut keys = Vec::with_capacity(n);
		for i in 0..n {
			let o = 17 + i * 40;
			keys.push((data[o..o + 32].try_into().unwrap(), u64::from_le_bytes(data[o + 32..o + 40].try_into().unwrap())));
		}
		Ok(Set { id, total, keys })
	}
	fn write(&self, data: &mut [u8]) {
		data[0..8].copy_from_slice(&self.id.to_le_bytes());
		data[8..16].copy_from_slice(&self.total.to_le_bytes());
		data[16] = self.keys.len() as u8;
		for (i, (k, p)) in self.keys.iter().enumerate() {
			let o = 17 + i * 40;
			data[o..o + 32].copy_from_slice(k);
			data[o + 32..o + 40].copy_from_slice(&p.to_le_bytes());
		}
		for b in data[17 + self.keys.len() * 40..CONFIG_SIZE].iter_mut() { *b = 0; }
	}
}

/// a new set from instruction data: n, then n x (key 32, power u64); keys strictly ascending, every power above 0
fn parse_set(d: &[u8], id: u64) -> Result<Set, ProgramError> {
	let n = *d.first().ok_or_else(|| fail("no validator set"))? as usize;
	if n == 0 || n > MAX_SIGNERS || d.len() != 1 + n * 40 { return Err(fail("bad validator set")); }
	let mut keys: Vec<([u8; 32], u64)> = Vec::with_capacity(n);
	let mut total: u64 = 0;
	for i in 0..n {
		let o = 1 + i * 40;
		let k: [u8; 32] = d[o..o + 32].try_into().unwrap();
		let p = u64::from_le_bytes(d[o + 32..o + 40].try_into().unwrap());
		if p == 0 { return Err(fail("every validator has some power")); }
		if let Some((last, _)) = keys.last() { if k <= *last { return Err(fail("keys must be distinct, in ascending order")); } }
		total = total.checked_add(p).ok_or_else(|| fail("too much power"))?;
		keys.push((k, p));
	}
	Ok(Set { id, total, keys })
}

/// what validators sign for a release
pub fn release_message(program: &Pubkey, set_id: u64, id: &[u8; 32], mint: &[u8; 32], to: &[u8; 32], amount: u64) -> Vec<u8> {
	let mut m = b"dznye-x-release".to_vec();
	m.extend_from_slice(program.as_ref()); m.extend_from_slice(&set_id.to_le_bytes());
	m.extend_from_slice(id); m.extend_from_slice(mint); m.extend_from_slice(to); m.extend_from_slice(&amount.to_le_bytes());
	m
}
/// what validators sign to change the set (the new set's bytes, hashed)
pub fn signers_message(program: &Pubkey, set_id: u64, new_set: &[u8]) -> Vec<u8> {
	let mut m = b"dznye-x-signers".to_vec();
	m.extend_from_slice(program.as_ref()); m.extend_from_slice(&set_id.to_le_bytes());
	m.extend_from_slice(hashv(&[new_set]).as_ref());
	m
}

/// More than two thirds of the set's power must have signed exactly `message` in Ed25519 instructions of this same
/// transaction (Solana's Ed25519 program has already checked each signature, or the transaction would have failed).
/// Every signature's key and message must sit inside its own Ed25519 instruction; each key counts once.
fn check_signed(set: &Set, message: &[u8], sysvar: &AccountInfo) -> ProgramResult {
	if *sysvar.key != ixs::ID { return Err(fail("not the instructions sysvar")); }
	let mut seen: Vec<[u8; 32]> = Vec::new();
	let mut said: u128 = 0;
	let mut i: usize = 0;
	while let Ok(ix) = ixs::load_instruction_at_checked(i, sysvar) {
		i += 1;
		if ix.program_id != ED25519_PROGRAM { continue; }
		let d = &ix.data;
		if d.len() < 2 { continue; }
		let count = d[0] as usize;
		for s in 0..count {
			let o = 2 + s * 14;
			if d.len() < o + 14 { return Err(fail("bad signature list")); }
			let u = |k: usize| u16::from_le_bytes([d[o + k], d[o + k + 1]]) as usize;
			let (pk_off, pk_ix, msg_off, msg_len, msg_ix, sig_ix) = (u(4), u(6), u(8), u(10), u(12), u(2));
			// the key, the message and the signature must all be inside this Ed25519 instruction
			if pk_ix != u16::MAX as usize || msg_ix != u16::MAX as usize || sig_ix != u16::MAX as usize { return Err(fail("signature data outside its instruction")); }
			if d.len() < pk_off + 32 || d.len() < msg_off + msg_len { return Err(fail("bad signature list")); }
			if &d[msg_off..msg_off + msg_len] != message { continue; } // signed something else: does not count here
			let key: [u8; 32] = d[pk_off..pk_off + 32].try_into().unwrap();
			if seen.contains(&key) { return Err(fail("a validator signed twice")); }
			let p = set.keys.iter().find(|(k, _)| *k == key).map(|(_, p)| *p).ok_or_else(|| fail("not a validator of this set"))?;
			seen.push(key);
			said += p as u128;
		}
	}
	if said * 3 <= (set.total as u128) * 2 { return Err(fail("not signed by more than two thirds")); }
	Ok(())
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> (Pubkey, u8) { Pubkey::find_program_address(seeds, program) }

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0 }

/// a token Transfer instruction (the token program's instruction 3), from `from` to `to`, authorised by `authority`
fn token_transfer_ix(from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
	let mut data = vec![3u8];
	data.extend_from_slice(&amount.to_le_bytes());
	Instruction { program_id: TOKEN_PROGRAM, accounts: vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*authority, true)], data }
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

/// make a program-derived account of `space` bytes, owned by this program. Someone may have sent SOL to its address first
/// (anyone can): then it is topped up to rent, given its space and taken over, so a few lamports can never block it.
fn make_pda<'a>(program: &Pubkey, payer: &AccountInfo<'a>, acct: &AccountInfo<'a>, sys: &AccountInfo<'a>, space: usize, seeds: &[&[u8]]) -> ProgramResult {
	let rent = Rent::get()?.minimum_balance(space);
	if acct.lamports() == 0 {
		return invoke_signed(&system_instruction::create_account(payer.key, acct.key, rent, space as u64, program), &[payer.clone(), acct.clone(), sys.clone()], &[seeds]);
	}
	if *acct.owner != system_program::ID || !acct.data_is_empty() { return Err(fail("that account is taken")); }
	let need = rent.saturating_sub(acct.lamports());
	if need > 0 { invoke(&system_instruction::transfer(payer.key, acct.key, need), &[payer.clone(), acct.clone(), sys.clone()])?; }
	if space > 0 { invoke_signed(&system_instruction::allocate(acct.key, space as u64), &[acct.clone(), sys.clone()], &[seeds])?; }
	invoke_signed(&system_instruction::assign(acct.key, program), &[acct.clone(), sys.clone()], &[seeds])
}

pub fn process(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
	let (tag, d) = data.split_first().ok_or_else(|| fail("empty instruction"))?;
	let a = &mut accounts.iter();
	match tag {
		// 0 Init(set): [payer, config, system]. Once. (A vault is listed on Dznye only after its set is checked there.)
		0 => {
			let payer = next_account_info(a)?; let config = next_account_info(a)?; let sys = next_account_info(a)?;
			let (key, bump) = pda(&[b"config"], program);
			if *config.key != key || !payer.is_signer || *sys.key != system_program::ID { return Err(fail("bad accounts")); }
			if config.owner == program { return Err(fail("already set up")); }
			let set = parse_set(d, 1)?;
			make_pda(program, payer, config, sys, CONFIG_SIZE, &[b"config", &[bump]])?;
			set.write(&mut config.try_borrow_mut_data()?);
			msg!("dznye-set 1");
			Ok(())
		}
		// 1 DepositSol(dznye 32, lamports u64): [depositor, vault, system]
		1 => {
			let who = next_account_info(a)?; let vault = next_account_info(a)?; let sys = next_account_info(a)?;
			if d.len() != 40 || !who.is_signer || *vault.key != pda(&[b"vault"], program).0 || *sys.key != system_program::ID { return Err(fail("bad deposit")); }
			let (dznye, amount) = (&d[0..32], u64::from_le_bytes(d[32..40].try_into().unwrap()));
			if amount == 0 || dznye.iter().all(|b| *b == 0) { return Err(fail("nothing sent, or no Dznye address")); }
			invoke(&system_instruction::transfer(who.key, vault.key, amount), &[who.clone(), vault.clone(), sys.clone()])?;
			msg!("dznye-deposit SOL {} {}", hex(dznye), amount);
			Ok(())
		}
		// 2 DepositToken(dznye 32, amount u64): [depositor, its token account, the vault's token account, mint, token program]
		2 => {
			let who = next_account_info(a)?; let from = next_account_info(a)?; let to = next_account_info(a)?; let mint = next_account_info(a)?; let token = next_account_info(a)?;
			if d.len() != 40 || !who.is_signer { return Err(fail("bad deposit")); }
			let vault = pda(&[b"vault"], program).0;
			if *to.key != ata(&vault, mint.key) { return Err(fail("not the vault's token account for that mint")); }
			let (dznye, amount) = (&d[0..32], u64::from_le_bytes(d[32..40].try_into().unwrap()));
			if amount == 0 || dznye.iter().all(|b| *b == 0) { return Err(fail("nothing sent, or no Dznye address")); }
			if *token.key != TOKEN_PROGRAM { return Err(fail("not the token program")); }
			invoke(&token_transfer_ix(from.key, to.key, who.key, amount), &[from.clone(), to.clone(), who.clone(), token.clone()])?;
			msg!("dznye-deposit {} {} {}", mint.key, hex(dznye), amount);
			Ok(())
		}
		// 3 Release(id 32, mint 32 (zeros: SOL), to 32, amount u64): [payer, config, released, vault, to, instructions
		//   sysvar, system] and for a token: [vault's token account, to's token account, token program]
		3 => {
			let payer = next_account_info(a)?; let config = next_account_info(a)?; let released = next_account_info(a)?; let vault = next_account_info(a)?;
			let dest = next_account_info(a)?; let sysvar = next_account_info(a)?; let sys = next_account_info(a)?;
			if d.len() != 104 || !payer.is_signer || *sys.key != system_program::ID { return Err(fail("bad release")); }
			let id: [u8; 32] = d[0..32].try_into().unwrap(); let mint: [u8; 32] = d[32..64].try_into().unwrap();
			let to: [u8; 32] = d[64..96].try_into().unwrap(); let amount = u64::from_le_bytes(d[96..104].try_into().unwrap());
			if amount == 0 { return Err(fail("nothing to pay")); }
			if *config.key != pda(&[b"config"], program).0 || config.owner != program { return Err(fail("not this vault's config")); }
			let (vault_key, vault_bump) = pda(&[b"vault"], program);
			if *vault.key != vault_key { return Err(fail("not this vault")); }
			let (rel_key, rel_bump) = pda(&[b"released", &id], program);
			if *released.key != rel_key { return Err(fail("not this payout's mark")); }
			if released.owner == program { return Err(fail("already released")); }
			let set = Set::read(&config.try_borrow_data()?)?;
			check_signed(&set, &release_message(program, set.id, &id, &mint, &to, amount), sysvar)?;
			// mark it paid first: the account exists from now on
			make_pda(program, payer, released, sys, 0, &[b"released", &id, &[rel_bump]])?;
			if mint == [0u8; 32] {
				if dest.key.to_bytes() != to { return Err(fail("not the payee")); }
				invoke_signed(&system_instruction::transfer(vault.key, dest.key, amount), &[vault.clone(), dest.clone(), sys.clone()], &[&[b"vault", &[vault_bump]]])?;
			} else {
				let from = next_account_info(a)?; let to_acct = next_account_info(a)?; let token = next_account_info(a)?;
				let mint_key = Pubkey::new_from_array(mint);
				if *from.key != ata(&vault_key, &mint_key) || *to_acct.key != ata(&Pubkey::new_from_array(to), &mint_key) { return Err(fail("not the vault's or the payee's token account")); }
				if *token.key != TOKEN_PROGRAM { return Err(fail("not the token program")); }
				invoke_signed(&token_transfer_ix(from.key, to_acct.key, vault.key, amount), &[from.clone(), to_acct.clone(), vault.clone(), token.clone()], &[&[b"vault", &[vault_bump]]])?;
			}
			msg!("dznye-released {} {}", hex(&id), amount);
			Ok(())
		}
		// 4 SetSigners(set): [config, instructions sysvar], signed by more than two thirds of the current set
		4 => {
			let config = next_account_info(a)?; let sysvar = next_account_info(a)?;
			if *config.key != pda(&[b"config"], program).0 || config.owner != program { return Err(fail("not this vault's config")); }
			let old = Set::read(&config.try_borrow_data()?)?;
			check_signed(&old, &signers_message(program, old.id, d), sysvar)?;
			let new = parse_set(d, old.id + 1)?;
			new.write(&mut config.try_borrow_mut_data()?);
			msg!("dznye-set {}", new.id);
			Ok(())
		}
		_ => Err(fail("unknown instruction")),
	}
}
