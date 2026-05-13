#!/usr/bin/env bun
/**
 * Verify our EIP-712 v4 digest matches ethers' implementation for both
 * a simple Mail example and a Seaport-shaped order.
 */
import { TypedDataEncoder, Wallet } from "ethers";
import { computeEip712Digest, type TypedData } from "../src/eip712.ts";
import { signDigest } from "@agiterra/wallet-tools";

const privKey = "0x4646464646464646464646464646464646464646464646464646464646464646";

// --- Test 1: simple Mail example from EIP-712 spec ---
const mail: TypedData = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to:   { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

const mailTypesForEthers = { ...mail.types };
delete mailTypesForEthers.EIP712Domain;
const expectedMailDigest = TypedDataEncoder.hash(mail.domain, mailTypesForEthers, mail.message);
const ourMailDigest = computeEip712Digest(mail);
console.log("Mail digest:");
console.log("  ours:    ", ourMailDigest);
console.log("  ethers:  ", expectedMailDigest);
const mailPass = ourMailDigest.toLowerCase() === expectedMailDigest.toLowerCase();
console.log(mailPass ? "  PASS" : "  FAIL");

// --- Test 2: Seaport-shaped order ---
const seaport: TypedData = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    OrderComponents: [
      { name: "offerer", type: "address" },
      { name: "zone", type: "address" },
      { name: "offer", type: "OfferItem[]" },
      { name: "consideration", type: "ConsiderationItem[]" },
      { name: "orderType", type: "uint8" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
      { name: "zoneHash", type: "bytes32" },
      { name: "salt", type: "uint256" },
      { name: "conduitKey", type: "bytes32" },
      { name: "counter", type: "uint256" },
    ],
    OfferItem: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
    ],
    ConsiderationItem: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
  },
  primaryType: "OrderComponents",
  domain: {
    name: "Seaport",
    version: "1.5",
    chainId: 11155111,
    verifyingContract: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
  },
  message: {
    offerer: "0xadd5a1b8f83cad37120dc0c80af29cd42406e7a6",
    zone: "0x0000000000000000000000000000000000000000",
    offer: [
      {
        itemType: 2,
        token: "0x1111111111111111111111111111111111111111",
        identifierOrCriteria: "1234",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: "0x0000000000000000000000000000000000000000",
        identifierOrCriteria: "0",
        startAmount: "100000000000000000",
        endAmount: "100000000000000000",
        recipient: "0xadd5a1b8f83cad37120dc0c80af29cd42406e7a6",
      },
    ],
    orderType: 0,
    startTime: "1700000000",
    endTime: "1800000000",
    zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    salt: "999",
    conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
    counter: "0",
  },
};
const seaTypesForEthers = { ...seaport.types };
delete seaTypesForEthers.EIP712Domain;
const expectedSeaDigest = TypedDataEncoder.hash(seaport.domain, seaTypesForEthers, seaport.message);
const ourSeaDigest = computeEip712Digest(seaport);
console.log("\nSeaport order digest:");
console.log("  ours:    ", ourSeaDigest);
console.log("  ethers:  ", expectedSeaDigest);
const seaPass = ourSeaDigest.toLowerCase() === expectedSeaDigest.toLowerCase();
console.log(seaPass ? "  PASS" : "  FAIL");

// --- Verify signature recovers ---
const sig = signDigest(ourSeaDigest, privKey);
const recovered = new Wallet(privKey).address;
console.log("\nSignature recovers correctly:", recovered);

process.exit(mailPass && seaPass ? 0 : 1);
