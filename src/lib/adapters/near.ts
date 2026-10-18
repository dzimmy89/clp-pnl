import { fetchJson } from "@/lib/http";

const NEAR_RPC = "https://rpc.mainnet.near.org";

interface NearQueryResponse {
  result?: {
    result?: number[];
    error?: string;
  };
  error?: { message?: string };
}

export async function nearView<T>(
  contract: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const body = await fetchJson<NearQueryResponse>(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "omnifolio",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  if (body.error?.message) throw new Error(body.error.message);
  if (body.result?.error) throw new Error(body.result.error);
  const bytes = body.result?.result;
  if (!bytes) throw new Error(`NEAR ${method} returned no result`);
  const text = Buffer.from(bytes).toString("utf8");
  return JSON.parse(text) as T;
}

export async function nearAccountBalance(accountId: string): Promise<number> {
  const body = await fetchJson<{
    result?: { amount?: string };
    error?: { message?: string };
  }>(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "omnifolio",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  if (body.error?.message) throw new Error(body.error.message);
  const yocto = BigInt(body.result?.amount ?? "0");
  return Number(yocto / 10n ** 18n) / 1e6;
}
