import { loadAccount, removeWallet, renameWallet } from "@/lib/server/accounts";
import { currentAccountId, errorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, ctx: RouteContext<"/api/account/wallets/[id]">) {
  try {
    const accountId = await currentAccountId();
    if (!accountId) return Response.json({ error: "Not signed in" }, { status: 401 });
    const { id } = await ctx.params;
    if (!UUID.test(id)) return Response.json({ error: "Wallet not found" }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { label?: unknown };
    if (typeof body.label !== "string") return Response.json({ error: "Missing label" }, { status: 400 });
    if (!(await renameWallet(accountId, id, body.label))) {
      return Response.json({ error: "Wallet not found" }, { status: 404 });
    }
    return Response.json({ account: await loadAccount(accountId) });
  } catch (error) {
    return errorResponse(error, "Could not rename wallet");
  }
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/account/wallets/[id]">) {
  try {
    const accountId = await currentAccountId();
    if (!accountId) return Response.json({ error: "Not signed in" }, { status: 401 });
    const { id } = await ctx.params;
    if (!UUID.test(id)) return Response.json({ error: "Wallet not found" }, { status: 404 });
    const result = await removeWallet(accountId, id);
    if (result === "missing") return Response.json({ error: "Wallet not found" }, { status: 404 });
    if (result === "last") {
      return Response.json({ error: "This is the only wallet that can sign in to this account, so it can't be removed." }, { status: 409 });
    }
    return Response.json({ account: await loadAccount(accountId) });
  } catch (error) {
    return errorResponse(error, "Could not remove wallet");
  }
}
