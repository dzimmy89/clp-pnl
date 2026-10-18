import { isWalletChain } from "@/lib/auth/message";
import { SignInError, verifySignIn, type SignInProof } from "@/lib/auth/verify";
import { AccountConflictError, consumeNonce, linkWallet, loadAccount, signInWallet } from "@/lib/server/accounts";
import { isOwnerWallet, PRIVATE_MESSAGE, privateSite } from "@/lib/server/owner";
import { rateLimited } from "@/lib/server/rate-limit";
import { currentAccountId, errorResponse, siteDomain, startSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * Body: the fields the wallet signed plus the signature, and `intent`.
 * `signin` finds or creates the account that owns the wallet and starts a session.
 * `link` adds the wallet to the account that is already signed in.
 */
export async function POST(request: Request) {
  const limited = await rateLimited("verify", 20);
  if (limited) return limited;
  let body: Partial<SignInProof> & { intent?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { chain, address, nonce, issuedAt, signature, uri } = body;
  if (!isWalletChain(chain) || !address || !nonce || !issuedAt || !signature || !uri) {
    return Response.json({ error: "Missing sign-in fields" }, { status: 400 });
  }
  const intent = body.intent === "link" ? "link" : "signin";

  try {
    const domain = await siteDomain();
    let uriHost = "";
    try {
      uriHost = new URL(uri).host;
    } catch {}
    if (uriHost !== domain) {
      return Response.json({ error: "Sign-in message was made for another site" }, { status: 400 });
    }

    const signedIn = await currentAccountId();
    if (intent === "link" && !signedIn) {
      return Response.json({ error: "Sign in before linking another wallet" }, { status: 401 });
    }

    if (!(await consumeNonce(nonce))) {
      return Response.json({ error: "Sign-in request expired. Try again." }, { status: 400 });
    }

    const proof: SignInProof = {
      chain,
      address,
      nonce,
      issuedAt,
      signature,
      uri,
      domain,
      chainId: typeof body.chainId === "number" ? body.chainId : undefined,
      publicKey: typeof body.publicKey === "string" ? body.publicKey : undefined,
      signedMessage: typeof body.signedMessage === "string" ? body.signedMessage : undefined,
      extra: stringRecord(body.extra),
    };
    const verified = await verifySignIn(proof, { domain, uri });
    // A private site signs in the owner's wallets only; once signed in, the owner can link any wallet.
    if (intent === "signin" && privateSite() && !isOwnerWallet(verified)) {
      return Response.json({ error: PRIVATE_MESSAGE, code: "private" }, { status: 403 });
    }

    let accountId: string;
    if (intent === "link" && signedIn) {
      await linkWallet(signedIn, chain, verified);
      accountId = signedIn;
    } else {
      accountId = await signInWallet(chain, verified);
      await startSession(accountId);
    }
    return Response.json({ account: await loadAccount(accountId) });
  } catch (error) {
    if (error instanceof SignInError) return Response.json({ error: error.message }, { status: 401 });
    if (error instanceof AccountConflictError) return Response.json({ error: error.message }, { status: 409 });
    return errorResponse(error, "Sign-in failed");
  }
}

/** Keeps only string values from a client-sent object, capped so a proof can't carry a payload. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, 8)) {
    if (typeof item === "string" && item.length <= 8192) out[key] = item;
  }
  return out;
}
