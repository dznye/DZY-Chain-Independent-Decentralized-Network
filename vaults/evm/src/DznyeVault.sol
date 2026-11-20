// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title The Dznye exchange's vault on an Ethereum-style chain (chain/EXCHANGE.md)
/// @notice Holds ETH and tokens (USDC) for people who bought DZY with them, and pays out only on proof that a sell-back
/// happened on Dznye: a release signed by validators holding more than two thirds of the current validator set's power.
/// There is no owner, no admin key, no upgrade and no pause. The validator set changes only by the current set's own
/// signatures. Every signature names this chain, this vault's address and the current set, so it is good nowhere else.
contract DznyeVault {
	/// the validators' keys (secp256k1 addresses), strictly ascending, and each one's power (its say)
	address[] private signerKeys;
	mapping(address => uint64) public powerOf;
	uint256 public totalPower;
	/// which validator set this is; it counts up with every change, and every signature names it
	uint64 public setId;
	/// releases already paid, by the payout's id on Dznye
	mapping(bytes32 => bool) public released;

	uint256 private constant MAX_SIGNERS = 128;
	/// half the order of secp256k1: a signature's s must be at most this (no second, "malleable" form of a signature)
	uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

	event Deposit(address indexed token, address indexed from, uint256 amount, bytes32 indexed dznye);
	event Released(bytes32 indexed id, address indexed token, address indexed to, uint256 amount);
	event SignersChanged(uint64 setId, address[] keys, uint64[] powers);

	constructor(address[] memory keys, uint64[] memory powers) { _setSigners(keys, powers); }

	/// coins sent without saying whose they are would belong to nobody: refused
	receive() external payable { revert("deposit with deposit(your Dznye address)"); }

	/// Deposit ETH for a Dznye address (the 32 bytes of its public key). Validators see the event and confirm it on Dznye.
	function deposit(bytes32 dznye) external payable {
		require(msg.value > 0, "nothing sent");
		require(dznye != bytes32(0), "name a Dznye address");
		emit Deposit(address(0), msg.sender, msg.value, dznye);
	}

	/// Deposit a token (after approve). What counts is what actually arrived, so a token that takes a cut is counted right.
	function depositToken(address token, uint256 amount, bytes32 dznye) external {
		require(amount > 0, "nothing sent");
		require(dznye != bytes32(0), "name a Dznye address");
		require(token.code.length > 0, "not a token");
		uint256 before = _balanceOf(token);
		_call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
		uint256 got = _balanceOf(token) - before;
		require(got > 0, "nothing arrived");
		emit Deposit(token, msg.sender, got, dznye);
	}

	/// Pay a sell-back made on Dznye: payout `id`, `amount` of `token` (address(0) for ETH, in wei) to `to`. Anyone may
	/// submit it (it pays its gas); it pays only with the signatures of more than two thirds of the current set's power.
	function release(bytes32 id, address token, address payable to, uint256 amount, bytes[] calldata sigs) external {
		require(!released[id], "already released");
		require(to != address(0) && amount > 0, "bad payout");
		_checkSigs(releaseDigest(id, token, to, amount), sigs);
		released[id] = true; // before paying: a payee that calls back finds it done
		if (token == address(0)) {
			(bool ok, ) = to.call{value: amount}("");
			require(ok, "ETH payment failed");
		} else {
			_call(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
		}
		emit Released(id, token, to, amount);
	}

	/// Change the validator set: signed by more than two thirds of the current set's power.
	function setSigners(address[] calldata keys, uint64[] calldata powers, bytes[] calldata sigs) external {
		_checkSigs(signersDigest(keys, powers), sigs);
		_setSigners(keys, powers);
	}

	/// what validators sign for a release (an Ethereum signed message, so ordinary tools can sign and check it)
	function releaseDigest(bytes32 id, address token, address to, uint256 amount) public view returns (bytes32) {
		return _ethMessage(keccak256(abi.encode("dznye-x-release", block.chainid, address(this), setId, id, token, to, amount)));
	}

	/// what validators sign to change the set
	function signersDigest(address[] calldata keys, uint64[] calldata powers) public view returns (bytes32) {
		return _ethMessage(keccak256(abi.encode("dznye-x-signers", block.chainid, address(this), setId, keys, powers)));
	}

	function signers() external view returns (address[] memory keys, uint64[] memory powers) {
		keys = signerKeys;
		powers = new uint64[](keys.length);
		for (uint256 i = 0; i < keys.length; i++) powers[i] = powerOf[keys[i]];
	}

	/* ---------------- inside ---------------- */

	/// the signers must be in the current set, each at most once (in ascending order of address), with more than two
	/// thirds of the total power between them
	function _checkSigs(bytes32 digest, bytes[] calldata sigs) private view {
		uint256 said = 0;
		address last = address(0);
		for (uint256 i = 0; i < sigs.length; i++) {
			address who = _recover(digest, sigs[i]);
			require(who > last, "signers must be distinct, in ascending order");
			uint64 p = powerOf[who];
			require(p > 0, "not a validator of this set");
			said += p;
			last = who;
		}
		require(said * 3 > totalPower * 2, "not signed by more than two thirds");
	}

	function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
		require(sig.length == 65, "a signature is 65 bytes");
		bytes32 r = bytes32(sig[0:32]);
		bytes32 s = bytes32(sig[32:64]);
		uint8 v = uint8(sig[64]);
		require(uint256(s) <= HALF_N, "malleable signature");
		require(v == 27 || v == 28, "bad signature");
		address who = ecrecover(digest, v, r, s);
		require(who != address(0), "bad signature");
		return who;
	}

	function _setSigners(address[] memory keys, uint64[] memory powers) private {
		require(keys.length > 0 && keys.length <= MAX_SIGNERS && keys.length == powers.length, "bad validator set");
		for (uint256 i = 0; i < signerKeys.length; i++) powerOf[signerKeys[i]] = 0;
		uint256 total = 0;
		address last = address(0);
		for (uint256 i = 0; i < keys.length; i++) {
			require(keys[i] > last, "keys must be distinct, in ascending order");
			require(powers[i] > 0, "every validator has some power");
			powerOf[keys[i]] = powers[i];
			total += powers[i];
			last = keys[i];
		}
		signerKeys = keys;
		totalPower = total;
		setId += 1;
		emit SignersChanged(setId, keys, powers);
	}

	function _ethMessage(bytes32 h) private pure returns (bytes32) {
		return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
	}

	function _balanceOf(address token) private view returns (uint256) {
		(bool ok, bytes memory out) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
		require(ok && out.length >= 32, "not a token");
		return abi.decode(out, (uint256));
	}

	/// a token call that must succeed: no answer (as some tokens give) or true
	function _call(address token, bytes memory data) private {
		(bool ok, bytes memory out) = token.call(data);
		require(ok && (out.length == 0 || abi.decode(out, (bool))), "token call failed");
	}
}
