// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The vault, written as attacks. Run (Foundry): forge test --root chain/vaults/evm
// No test library is needed: Foundry's cheatcodes are called through this small interface.
import { DznyeVault } from "../src/DznyeVault.sol";

interface Vm {
	function addr(uint256 pk) external returns (address);
	function sign(uint256 pk, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
	function deal(address who, uint256 amount) external;
	function prank(address who) external;
	function expectRevert(bytes calldata why) external;
	function chainId(uint256 id) external;
}

/// a USDC-like token (6 decimals), optionally one that answers false instead of reverting, or takes a 1% cut
contract Token {
	mapping(address => uint256) public balanceOf;
	mapping(address => mapping(address => uint256)) public allowance;
	bool public answersFalse; bool public takesCut;
	constructor(bool f, bool c) { answersFalse = f; takesCut = c; }
	function mint(address to, uint256 n) external { balanceOf[to] += n; }
	function approve(address s, uint256 n) external returns (bool) { allowance[msg.sender][s] = n; return true; }
	function transfer(address to, uint256 n) external returns (bool) { if (answersFalse) return false; _move(msg.sender, to, n); return true; }
	function transferFrom(address f, address to, uint256 n) external returns (bool) {
		if (answersFalse) return false;
		require(allowance[f][msg.sender] >= n, "allowance"); allowance[f][msg.sender] -= n; _move(f, to, n); return true;
	}
	function _move(address f, address to, uint256 n) private { require(balanceOf[f] >= n, "balance"); balanceOf[f] -= n; balanceOf[to] += takesCut ? n - n / 100 : n; }
}

/// a payee that tries to be paid twice by calling release again from inside its payment
contract Greedy {
	DznyeVault v; bytes32 id; bytes[] sigs; uint256 public got; uint256 public tries;
	function arm(DznyeVault vault, bytes32 i, bytes[] memory s) external { v = vault; id = i; delete sigs; for (uint256 k = 0; k < s.length; k++) sigs.push(s[k]); }
	receive() external payable {
		got += msg.value; tries++;
		if (tries == 1) { try v.release(id, address(0), payable(address(this)), msg.value, sigs) {} catch {} }
	}
}

contract DznyeVaultTest {
	Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
	uint256[] pks; address[] keys; uint64[] powers;
	DznyeVault vault;
	bytes32 constant ALICE = bytes32(uint256(0xa11ce));
	address payable constant PAYEE = payable(address(0xBEEF));

	function setUp() public {
		delete pks; delete keys; delete powers;
		// four validators, keys sorted ascending (the vault requires it), one power each
		uint256[4] memory raw = [uint256(0x1111), 0x2222, 0x3333, 0x4444];
		for (uint256 i = 0; i < 4; i++) { pks.push(raw[i]); keys.push(vm.addr(raw[i])); powers.push(1); }
		for (uint256 i = 0; i < 4; i++) for (uint256 j = i + 1; j < 4; j++) if (keys[j] < keys[i]) { (keys[i], keys[j]) = (keys[j], keys[i]); (pks[i], pks[j]) = (pks[j], pks[i]); }
		vault = new DznyeVault(keys, powers);
		vm.deal(address(this), 100 ether);
		vault.deposit{value: 10 ether}(ALICE);
	}

	function sig(uint256 pk, bytes32 d) internal returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }
	/// signatures by the validators at these positions (ascending order kept)
	function sigs(bytes32 d, uint256[] memory who) internal returns (bytes[] memory out) { out = new bytes[](who.length); for (uint256 i = 0; i < who.length; i++) out[i] = sig(pks[who[i]], d); }
	function three() internal pure returns (uint256[] memory w) { w = new uint256[](3); w[0] = 0; w[1] = 1; w[2] = 2; }
	function two() internal pure returns (uint256[] memory w) { w = new uint256[](2); w[0] = 0; w[1] = 1; }
	function eq(uint256 a, uint256 b, string memory m) internal pure { require(a == b, m); }

	function test_deposits_are_held_and_unnamed_coins_refused() public {
		eq(address(vault).balance, 10 ether, "deposit not held");
		vm.expectRevert(bytes("name a Dznye address")); vault.deposit{value: 1}(bytes32(0));
		vm.expectRevert(bytes("nothing sent")); vault.deposit{value: 0}(ALICE);
		(bool ok, ) = address(vault).call{value: 1 ether}(""); require(!ok, "a plain send was accepted");
	}

	function test_three_of_four_release_once_two_of_four_cannot() public {
		bytes32 id = keccak256("payout-1");
		bytes32 d = vault.releaseDigest(id, address(0), PAYEE, 1 ether);
		vm.expectRevert(bytes("not signed by more than two thirds")); vault.release(id, address(0), PAYEE, 1 ether, sigs(d, two()));
		vault.release(id, address(0), PAYEE, 1 ether, sigs(d, three()));
		eq(PAYEE.balance, 1 ether, "not paid");
		vm.expectRevert(bytes("already released")); vault.release(id, address(0), PAYEE, 1 ether, sigs(d, three()));
	}

	function test_a_changed_amount_payee_or_id_breaks_the_signatures() public {
		bytes32 id = keccak256("payout-2");
		bytes[] memory s = sigs(vault.releaseDigest(id, address(0), PAYEE, 1 ether), three());
		vm.expectRevert(bytes("not a validator of this set")); vault.release(id, address(0), PAYEE, 2 ether, s);
		vm.expectRevert(bytes("not a validator of this set")); vault.release(id, address(0), payable(address(0xBAD)), 1 ether, s);
		vm.expectRevert(bytes("not a validator of this set")); vault.release(keccak256("other"), address(0), PAYEE, 1 ether, s);
	}

	function test_signatures_are_good_nowhere_else_not_on_another_vault_or_chain() public {
		DznyeVault twin = new DznyeVault(keys, powers);
		twin.deposit{value: 5 ether}(ALICE);
		bytes32 id = keccak256("payout-3");
		bytes[] memory s = sigs(vault.releaseDigest(id, address(0), PAYEE, 1 ether), three());
		vm.expectRevert(bytes("not a validator of this set")); twin.release(id, address(0), PAYEE, 1 ether, s);
		vm.chainId(8453); // the same vault address on Base
		vm.expectRevert(bytes("not a validator of this set")); vault.release(id, address(0), PAYEE, 1 ether, s);
	}

	function test_no_signer_twice_no_outsider_no_malleable_signature() public {
		bytes32 id = keccak256("payout-4");
		bytes32 d = vault.releaseDigest(id, address(0), PAYEE, 1 ether);
		bytes[] memory dup = new bytes[](3); dup[0] = sig(pks[0], d); dup[1] = sig(pks[0], d); dup[2] = sig(pks[1], d);
		vm.expectRevert(bytes("signers must be distinct, in ascending order")); vault.release(id, address(0), PAYEE, 1 ether, dup);
		bytes[] memory out = new bytes[](3); out[0] = sig(pks[0], d); out[1] = sig(pks[1], d); out[2] = sig(0x9999, d);
		// an outsider's key may sort anywhere: either the order check or the set check refuses it
		(bool ok, ) = address(vault).call(abi.encodeWithSelector(vault.release.selector, id, address(0), PAYEE, 1 ether, out));
		require(!ok, "an outsider's signature counted");
		(uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[2], d);
		bytes32 highS = bytes32(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(s));
		bytes[] memory mal = sigs(d, two()); bytes[] memory m3 = new bytes[](3); m3[0] = mal[0]; m3[1] = mal[1]; m3[2] = abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27));
		vm.expectRevert(bytes("malleable signature")); vault.release(id, address(0), PAYEE, 1 ether, m3);
	}

	function test_the_set_changes_only_by_its_own_signatures_and_old_signatures_then_fail() public {
		bytes32 id = keccak256("payout-5");
		bytes[] memory old = sigs(vault.releaseDigest(id, address(0), PAYEE, 1 ether), three());
		address[] memory nk = new address[](1); nk[0] = vm.addr(0x5555); uint64[] memory np = new uint64[](1); np[0] = 1;
		bytes[] memory weak = sigs(vault.signersDigest(nk, np), two());
		bytes[] memory enough = sigs(vault.signersDigest(nk, np), three());
		vm.expectRevert(bytes("not signed by more than two thirds")); vault.setSigners(nk, np, weak);
		vault.setSigners(nk, np, enough);
		eq(vault.setId(), 2, "set not changed");
		vm.expectRevert(bytes("not a validator of this set")); vault.release(id, address(0), PAYEE, 1 ether, old);
		bytes[] memory fresh = new bytes[](1); fresh[0] = sig(0x5555, vault.releaseDigest(id, address(0), PAYEE, 1 ether));
		vault.release(id, address(0), PAYEE, 1 ether, fresh);
		eq(PAYEE.balance, 1 ether, "the new set could not release");
	}

	function test_power_counts_not_heads() public {
		address[] memory k = new address[](2); uint64[] memory p = new uint64[](2);
		k[0] = keys[0]; k[1] = keys[1]; p[0] = 3; p[1] = 1; // the first has 3 of the 4 power
		DznyeVault v2 = new DznyeVault(k, p); v2.deposit{value: 1 ether}(ALICE);
		bytes32 id = keccak256("payout-6");
		bytes[] memory one = new bytes[](1); one[0] = sig(pks[0], v2.releaseDigest(id, address(0), PAYEE, 1 ether));
		v2.release(id, address(0), PAYEE, 1 ether, one);
		bytes[] memory weak = new bytes[](1); weak[0] = sig(pks[1], v2.releaseDigest(keccak256("p7"), address(0), PAYEE, 1));
		vm.expectRevert(bytes("not signed by more than two thirds")); v2.release(keccak256("p7"), address(0), PAYEE, 1, weak);
	}

	function test_a_payee_that_calls_back_is_paid_once() public {
		Greedy g = new Greedy();
		bytes32 id = keccak256("payout-8");
		bytes[] memory s = sigs(vault.releaseDigest(id, address(0), payable(address(g)), 1 ether), three());
		g.arm(vault, id, s);
		vault.release(id, address(0), payable(address(g)), 1 ether, s);
		eq(g.got(), 1 ether, "paid more than once");
		eq(address(vault).balance, 9 ether, "the vault paid out twice");
	}

	function test_tokens_deposit_what_arrives_and_release_or_refuse() public {
		Token usdc = new Token(false, false); usdc.mint(address(this), 1_000e6); usdc.approve(address(vault), 1_000e6);
		vault.depositToken(address(usdc), 500e6, ALICE);
		eq(usdc.balanceOf(address(vault)), 500e6, "token deposit not held");
		bytes32 id = keccak256("payout-9");
		vault.release(id, address(usdc), PAYEE, 100e6, sigs(vault.releaseDigest(id, address(usdc), PAYEE, 100e6), three()));
		eq(usdc.balanceOf(PAYEE), 100e6, "token not paid");
		Token bad = new Token(true, false); bad.mint(address(this), 10e6); bad.approve(address(vault), 10e6);
		vm.expectRevert(bytes("token call failed")); vault.depositToken(address(bad), 10e6, ALICE);
		Token cut = new Token(false, true); cut.mint(address(this), 100e6); cut.approve(address(vault), 100e6);
		vault.depositToken(address(cut), 100e6, ALICE); // the event says 99e6 arrived; the vault holds 99e6
		eq(cut.balanceOf(address(vault)), 99e6, "a cut token counted wrong");
		vm.expectRevert(bytes("not a token")); vault.depositToken(address(0x1234), 1, ALICE);
	}

	function test_more_than_the_vault_holds_cannot_be_paid() public {
		bytes32 id = keccak256("payout-10");
		bytes[] memory s = sigs(vault.releaseDigest(id, address(0), PAYEE, 11 ether), three());
		vm.expectRevert(bytes("ETH payment failed")); vault.release(id, address(0), PAYEE, 11 ether, s);
		require(!vault.released(id), "a failed payout was marked paid");
	}
}
