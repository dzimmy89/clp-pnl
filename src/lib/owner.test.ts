import { describe, expect, it } from "vitest";
import { isOwnerAddress, parseOwnerWallets } from "@/lib/owner";

describe("owner wallets", () => {
  it("is empty, so the site stays open, when nothing is set", () => {
    expect(parseOwnerWallets(undefined).size).toBe(0);
    expect(parseOwnerWallets(" , \n").size).toBe(0);
  });

  it("splits on commas, spaces and new lines", () => {
    const owners = parseOwnerWallets("0xAbC0000000000000000000000000000000000001, alice.near\n7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(owners.size).toBe(3);
  });

  it("matches hex and NEAR addresses in any case, base58 exactly", () => {
    const owners = parseOwnerWallets("0xAbC0000000000000000000000000000000000001 Alice.near 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(isOwnerAddress(owners, "0xabc0000000000000000000000000000000000001")).toBe(true);
    expect(isOwnerAddress(owners, "alice.near")).toBe(true);
    expect(isOwnerAddress(owners, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe(true);
    expect(isOwnerAddress(owners, "7xkxtg2cw87d97txjsdpbd5jbkhetqa83tzrujosgasu")).toBe(false);
    expect(isOwnerAddress(owners, "0xabc0000000000000000000000000000000000002")).toBe(false);
  });
});

describe("owner wallets in another stored form", () => {
  it("adds the forms a chain's sign-in stores", () => {
    const owners = parseOwnerWallets("UQfriendly", (address) => (address === "UQfriendly" ? ["0:RAW"] : []));
    expect(isOwnerAddress(owners, "UQfriendly")).toBe(true);
    expect(isOwnerAddress(owners, "0:RAW")).toBe(true);
  });
});
