"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { evaluateAlerts } from "@/lib/alerts";
import { EXAMPLE_BTC_PRICE, EXAMPLE_POSITIONS, EXAMPLE_SPOT } from "@/lib/examples";
import { formatUsd, priceTimestampLabel, setAmountsHidden } from "@/lib/format";
import { freshAlerts, titleWithAlerts } from "@/lib/alert-watch";
import { bookCsv, csvFileName } from "@/lib/export";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { exampleHistory, loadHistory, recordHistory, type HistoryPoint, type HistoryWrite } from "@/lib/history";
import { fetchAccountHistory, postHistory, useAccountSync, type SyncStatus } from "@/lib/account-sync";
import { useManualPrices } from "@/lib/manual-prices";
import { portfolioMetrics } from "@/lib/metrics";
import { bookTotals, netOf } from "@/lib/overview";
import { runScenario } from "@/lib/scenario";
import { commitDesk, currentDesk, useDesk } from "@/lib/storage";
import type { BookResponse, PastedWallet, Position, ProtocolId } from "@/lib/types";
import { AccountControl, AccountWallets } from "@/components/account-control";
import { BrandLink } from "@/components/brand";
import { AddressBar } from "@/components/address-bar";
import { ManualBalances } from "@/components/manual-balances";
import {
  AlertsPanel,
  notionalOf,
  ProtocolRow,
  ScenarioPanel,
  underlyingList,
  WalletFilter,
} from "@/components/desk-panels";
import { Panel, SectionLabel } from "@/components/ledger-ui";
import { OverviewTab } from "@/components/overview-tab";
import { LiquidityTab } from "@/components/liquidity-tab";
import { PortfolioTab } from "@/components/portfolio-tab";
import { PositionDialog } from "@/components/position-dialog";
import { PositionCard } from "@/components/position-ui";
import { useAccount } from "@/lib/account";
import { filterByWallet, trackedWallets, walletKey, walletQuery, walletSetOf } from "@/lib/wallet-set";
import { applyViewFilter, filterOptions, isLending, NO_FILTER, validFilter, type ViewFilter } from "@/lib/view-filter";
import { ViewFilterBar } from "@/components/view-filter-bar";
import { AdvisorTab } from "@/components/advisor-tab";
import { betaTargets, EXAMPLE_BETAS, type BetaBook } from "@/lib/beta";
import { Button } from "@/components/ui/button";
import { BellIcon, BellOffIcon, DownloadIcon, EyeIcon, EyeOffIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "cn";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "portfolio", label: "Portfolio" },
  { id: "liquidity", label: "Liquidity" },
  { id: "advisor", label: "Advisor" },
  { id: "wallets", label: "Wallets" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const isTab = (value: string): value is TabId => TABS.some((item) => item.id === value);

/** How often the open page re-reads the book on its own. */
const AUTO_REFRESH_MS = 5 * 60 * 1000;

function agoLabel(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function applyTargets(positions: Position[], targets: Record<string, number>): Position[] {
  return positions.map((position) => ({
    ...position,
    targetHedgeRatio: targets[position.id] ?? position.targetHedgeRatio,
  }));
}

function withTarget(targets: Record<string, number>, id: string, value: number | null): Record<string, number> {
  const next = { ...targets };
  if (value == null) delete next[id];
  else next[id] = value;
  return next;
}

function SyncNote({ status, error }: { status: SyncStatus; error: string | null }) {
  const text =
    status === "error"
      ? `Not saved to your account: ${error ?? "unknown error"}. Your changes are kept in this browser and saved on the next edit.`
      : status === "loading"
        ? "Loading what's saved on your account…"
        : status === "saving"
          ? "Saving to your account…"
          : "Pasted addresses, manual books and balances, targets, goals and net worth history are saved to your account.";
  return <p className={status === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{text}</p>;
}

export function Dashboard() {
  const desk = useDesk();
  const [live, setLive] = useState<BookResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [shocks, setShocks] = useState<Record<string, string>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const accountState = useAccount();
  const [editing, setEditing] = useState<Position | null>(null);
  const [preset, setPreset] = useState<ProtocolId | null>(null);

  const [walletFilter, setWalletFilter] = useState<string | null>(null);
  const [viewFilter, setViewFilter] = useState<ViewFilter>(NO_FILTER);
  const [tab, setTabState] = useState<TabId>("overview");
  const prefs = usePrefs();
  // Set before the children render, so every amount on the page formats the same way.
  setAmountsHidden(prefs.hideAmounts);
  useEffect(() => () => setAmountsHidden(false), []);

  // The open tab lives in the address (#portfolio), so a reload or a bookmark comes back to it.
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      if (isTab(id)) setTabState(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  function setTab(id: TabId) {
    setTabState(id);
    window.history.replaceState(null, "", `#${id}`);
  }
  /** Opens Portfolio and scrolls to one position's card. */
  function openPosition(positionId: string) {
    setTab("portfolio");
    window.setTimeout(() => {
      const card = document.getElementById(`position-${positionId}`);
      card?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  }
  const accountWallets = accountState.account?.wallets;
  const accountId = accountState.account?.id ?? null;
  const sync = useAccountSync(accountId, accountState.loading, desk);
  const manualPrices = useManualPrices(desk.manualSpot, desk.manual, live);
  const bookMissing = manualPrices.missing.filter((symbol) =>
    desk.manual.some((book) => book.legs.some((leg) => !leg.fixedPrice && leg.symbol.toUpperCase() === symbol)),
  );
  const tracked = useMemo(
    () => trackedWallets(accountWallets ?? [], desk.pasted),
    [accountWallets, desk.pasted],
  );
  // Changes when the signed-in account gains or loses a wallet, or someone signs in or out.
  const accountKey = (accountWallets ?? []).map((w) => `${w.chain}:${w.address}`).join(",");

  useEffect(() => {
    if (desk.mode !== "live") return;
    void refresh(desk.pasted);
    // Adding or removing a pasted address refreshes from its handler. This runs when the
    // mode becomes live, when the account's wallets change and when its saved desk loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.mode, accountKey, sync.version]);

  useEffect(() => {
    // Signing in with a wallet means "show me my book", so leave the example set.
    if (accountKey && desk.mode === "example") commitDesk({ ...desk, mode: "live" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  const lastAttempt = useRef(0);
  /** The wallet query the book on screen was read for. */
  const fetchedFor = useRef<string | null>(null);
  async function refresh(pasted: PastedWallet[]) {
    lastAttempt.current = Date.now();
    setLoading(true);
    setFetchError(null);
    const query = walletQuery(walletSetOf(trackedWallets(accountWallets ?? [], pasted)));
    try {
      const response = await fetch(`/api/book?${query}`);
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error((response.status === 429 || response.status === 401) && failure?.error ? failure.error : `Book request failed (${response.status})`);
      }
      const body = (await response.json()) as BookResponse;
      fetchedFor.current = query;
      setLive(body);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }

  const mode = desk.mode;
  // A filter pointing at a wallet that's no longer tracked falls back to all wallets.
  const activeFilter =
    mode === "live" && walletFilter && tracked.some((w) => walletKey(w.address) === walletFilter) ? walletFilter : null;
  const allLivePositions = useMemo(
    () => live?.protocols.flatMap((protocol) => protocol.positions) ?? [],
    [live],
  );
  const walletPositions = useMemo(() => {
    if (mode === "example") return applyTargets(EXAMPLE_POSITIONS, desk.hedgeTargets);
    // Manual books aren't tied to a tracked wallet, so they only show under "All wallets".
    const fetched = filterByWallet(allLivePositions, activeFilter);
    return applyTargets(activeFilter ? fetched : [...fetched, ...desk.manual], desk.hedgeTargets);
  }, [desk, allLivePositions, mode, activeFilter]);
  const walletSpot = useMemo(
    // Balances entered by hand aren't tied to a tracked wallet, so they only show under "All wallets".
    () => (mode === "example" ? EXAMPLE_SPOT : [...filterByWallet(live?.spot ?? [], activeFilter), ...(activeFilter ? [] : desk.manualSpot)]),
    [mode, live, activeFilter, desk.manualSpot],
  );
  // Chain, app and type filters narrow whatever the wallet filter left.
  const viewOptions = useMemo(() => filterOptions(walletPositions, walletSpot), [walletPositions, walletSpot]);
  const activeView = validFilter(viewFilter, viewOptions);
  const { positions, spot } = useMemo(
    () => applyViewFilter(walletPositions, walletSpot, activeView),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeView is rebuilt each render; its fields are the inputs
    [walletPositions, walletSpot, activeView.chain, activeView.app, activeView.type],
  );
  const btcPrice = mode === "example" ? EXAMPLE_BTC_PRICE : (live?.btcPrice ?? 0);

  // BTC betas for every asset in the live book, fetched once per set of assets.
  const [liveBetas, setLiveBetas] = useState<BetaBook>({});
  const [betaError, setBetaError] = useState<string | null>(null);
  const betaAssets = useMemo(
    () => (mode === "live" ? betaTargets([...allLivePositions, ...desk.manual], [...(live?.spot ?? []), ...desk.manualSpot]) : []),
    [mode, allLivePositions, desk.manual, desk.manualSpot, live],
  );
  const betaQuery = betaAssets.map((asset) => `asset=${encodeURIComponent(asset)}`).join("&");
  useEffect(() => {
    if (!betaQuery) return;
    let cancelled = false;
    fetch(`/api/betas?${betaQuery}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`Beta request failed (${response.status})`))))
      .then((body: { betas?: BetaBook; error?: string }) => {
        if (cancelled) return;
        setLiveBetas((current) => ({ ...current, ...body.betas }));
        setBetaError(body.error ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setBetaError(error instanceof Error ? error.message : "Beta request failed");
      });
    return () => {
      cancelled = true;
    };
  }, [betaQuery]);
  const betas = mode === "example" ? EXAMPLE_BETAS : liveBetas;
  const book = useMemo(
    () => portfolioMetrics(positions, spot, btcPrice > 0 ? btcPrice : 0),
    [positions, spot, btcPrice],
  );
  const alerts = useMemo(
    () => (desk ? evaluateAlerts(book.rows, desk.thresholds) : []),
    [book.rows, desk],
  );

  // Alerts on the whole live book (every wallet, no filters), for the tab title and
  // notifications, so switching a filter never looks like a new problem.
  const currentQuery = walletQuery(walletSetOf(tracked));
  const bookAlerts = useMemo(() => {
    if (mode !== "live" || !live) return [];
    const all = portfolioMetrics(
      applyTargets([...allLivePositions, ...desk.manual], desk.hedgeTargets),
      [...live.spot, ...desk.manualSpot],
      btcPrice > 0 ? btcPrice : 0,
    );
    return evaluateAlerts(all.rows, desk.thresholds);
  }, [mode, live, allLivePositions, desk.manual, desk.manualSpot, desk.hedgeTargets, desk.thresholds, btcPrice]);

  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    baseTitle.current ??= document.title;
    document.title = titleWithAlerts(baseTitle.current, bookAlerts);
  }, [bookAlerts]);
  useEffect(
    () => () => {
      if (baseTitle.current) document.title = baseTitle.current;
    },
    [],
  );

  const seenAlerts = useRef<{ query: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    // Only a book read for the wallets tracked now counts; a stale one would look like news.
    if (mode !== "live" || !live || fetchedFor.current !== currentQuery) return;
    const seen = seenAlerts.current?.query === currentQuery ? seenAlerts.current.ids : null;
    const fresh = freshAlerts(seen, bookAlerts);
    seenAlerts.current = { query: currentQuery, ids: new Set(bookAlerts.map((alert) => alert.id)) };
    // Someone looking at the page already sees it; a notification is for when they aren't.
    if (!fresh.length || !prefs.notify || document.hasFocus() || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    for (const alert of fresh.slice(0, 3)) {
      new Notification(alert.severity === "critical" ? "Omnifolio: critical alert" : "Omnifolio: alert", {
        body: alert.sentence,
        tag: alert.id,
        icon: "/icon.svg",
      });
    }
  }, [bookAlerts, currentQuery, live, mode, prefs.notify]);

  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  async function toggleNotify() {
    setNotifyNote(null);
    if (prefs.notify) return setPrefs({ notify: false });
    if (typeof Notification === "undefined") return setNotifyNote("This browser can't show notifications.");
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return setNotifyNote("Notifications are blocked for this site. Allow them in the browser's site settings.");
    // Alerts only reach a page that's open, so keep reading the book in the background.
    setPrefs({ notify: true, autoRefresh: true });
  }

  // Re-read the book every few minutes while the page is open: while it's on screen, and in a
  // background tab too when notifications are on, since that's when they matter.
  const latestRefresh = useRef(refresh);
  useEffect(() => {
    latestRefresh.current = refresh;
  });
  useEffect(() => {
    if (mode !== "live" || !prefs.autoRefresh) return;
    const tick = () => {
      if (document.visibilityState !== "visible" && !prefs.notify) return;
      if (Date.now() - lastAttempt.current >= AUTO_REFRESH_MS) void latestRefresh.current(currentDesk().pasted);
    };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [mode, prefs.autoRefresh, prefs.notify]);

  // A clock for "updated 3m ago".
  const [now, setNow] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only clock
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const shockMap = useMemo(() => {
    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(shocks)) {
      const number = Number(value);
      if (value.trim() !== "" && Number.isFinite(number)) parsed[key] = number / 100;
    }
    return parsed;
  }, [shocks]);
  const scenario = useMemo(
    () => runScenario(positions, spot, btcPrice > 0 ? btcPrice : 0, shockMap),
    [positions, spot, btcPrice, shockMap],
  );

  function patch(partial: Partial<typeof desk>) {
    commitDesk({ ...desk, ...partial });
  }

  const volatileUnderlyings = underlyingList(positions, spot, false);
  const stableUnderlyings = underlyingList(positions, spot, true);
  const hasLiveBook = positions.length > 0;
  // Cards with hedge and health detail are for lending books; the rest are listed by app on Overview.
  const lendingRows = book.rows.filter((row) => isLending(row.position));
  const lpCount = book.rows.filter((row) => row.position.lp != null).length;
  const otherCount = book.rows.length - lendingRows.length - lpCount;
  const waiting = mode === "live" && loading && !live;

  // Net-worth history: one series for the whole book, one per wallet. Saved in this browser,
  // and on the account when signed in so it follows you to other devices.
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const recordedBook = useRef<BookResponse | null>(null);
  const bookScope = `book:${accountId ?? "device"}`;
  const historyScope = activeFilter ? `wallet:${activeFilter}` : bookScope;
  const exampleNet = mode === "example" ? bookTotals(book.rows, spot).netWorthUsd : 0;
  useEffect(() => {
    if (mode === "example") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only clock and storage
      setHistory(exampleHistory(exampleNet));
      return;
    }
    const writes: HistoryWrite[] = [];
    if (live && recordedBook.current !== live) {
      // Record once per fetched book, not again when only the scope changes.
      recordedBook.current = live;
      const t = Date.parse(live.fetchedAt) || Date.now();
      writes.push({ scope: bookScope, t, usd: netOf([...allLivePositions, ...desk.manual], [...live.spot, ...desk.manualSpot]) });
      for (const wallet of tracked) {
        const key = walletKey(wallet.address);
        writes.push({ scope: `wallet:${key}`, t, usd: netOf(filterByWallet(allLivePositions, key), filterByWallet(live.spot, key)) });
      }
      for (const write of writes) recordHistory(write.scope, { t: write.t, usd: write.usd });
    }
    setHistory(loadHistory(historyScope));
    if (!sync.synced) return;
    let cancelled = false;
    (writes.length ? postHistory(writes) : Promise.resolve())
      .then(() => fetchAccountHistory(historyScope))
      .then((points) => {
        if (!cancelled && points.length) setHistory(points);
      })
      // The browser's own series stays on screen when the account's can't be reached.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, historyScope, mode, exampleNet, sync.synced, sync.version]);

  const fetchedAt = live ? Date.parse(live.fetchedAt) : NaN;
  const updated = Number.isFinite(fetchedAt)
    ? new Date(fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : null;
  const filtered = activeView.chain != null || activeView.app != null || activeView.type != null;
  const title = { overview: "Overview", portfolio: "Portfolio", liquidity: "Liquidity", advisor: "Advisor", wallets: "Wallets" }[tab];
  const subtitle = {
    overview: "Every position and balance across your wallets.",
    portfolio: "Net worth over time, risk, and where your exposure sits.",
    liquidity: "Uniswap V3 and V4 positions: PnL, impermanent loss, fees and gas, read live from the chain.",
    advisor: "Suggested changes to reach your safety, leverage, hedge and BTC beta targets.",
    wallets: "The wallets this portfolio reads, and how each protocol answered.",
  }[tab];

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 md:grid-cols-[1fr_auto_1fr]">
          <BrandLink compact />
          <nav
            aria-label="Sections"
            className="order-last col-span-2 flex justify-self-center rounded-full border border-border bg-card p-1 md:order-none md:col-span-1"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
                className={cn(
                  "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                  tab === item.id ? "bg-gold text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center justify-end gap-1 sm:gap-2">
            <div className="hidden rounded-full border border-border bg-card p-0.5 text-xs sm:flex" role="group" aria-label="Book">
              {(["example", "live"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => patch({ mode: value })}
                  className={cn(
                    "rounded-full px-3 py-1 capitalize",
                    mode === value ? "bg-azure/20 text-azure" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={prefs.hideAmounts}
              aria-label={prefs.hideAmounts ? "Show amounts" : "Hide amounts"}
              title={prefs.hideAmounts ? "Show amounts" : "Hide amounts (for screen sharing)"}
              onClick={() => setPrefs({ hideAmounts: !prefs.hideAmounts })}
            >
              {prefs.hideAmounts ? <EyeOffIcon className="text-gold" /> : <EyeIcon />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={prefs.notify}
              aria-label={prefs.notify ? "Turn off alert notifications" : "Notify me about new alerts"}
              title={
                prefs.notify
                  ? "Notifying you about new alerts while this page is open. Click to turn off."
                  : "Notify me when a position crosses an alert line while this page is open"
              }
              onClick={() => void toggleNotify()}
            >
              {prefs.notify ? <BellIcon className="text-gold" /> : <BellOffIcon />}
            </Button>
            <AccountControl state={accountState} onManage={() => setTab("wallets")} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-azure/90">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
            {mode === "live" ? (
              <>
                {updated ? (
                  <span className="font-mono" title={`Last read at ${updated}`}>
                    Updated {now ? agoLabel(fetchedAt, now) : updated}
                  </span>
                ) : null}
                <label className="flex cursor-pointer items-center gap-1.5" title="Re-read every wallet every 5 minutes while this page is open">
                  <input
                    type="checkbox"
                    className="accent-[var(--gold)]"
                    checked={prefs.autoRefresh}
                    onChange={(event) => setPrefs({ autoRefresh: event.target.checked })}
                  />
                  Auto
                </label>
                <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void refresh(desk.pasted)}>
                  <RefreshCwIcon className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setTab("wallets")}>
                Use my wallets
              </Button>
            )}
            {tab !== "wallets" && (positions.length > 0 || spot.length > 0) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                title="Download every position and balance in this view as a spreadsheet"
                onClick={() => download(csvFileName(), bookCsv(book.rows, spot))}
              >
                <DownloadIcon /> CSV
              </Button>
            ) : null}
          </div>
        </div>

        {fetchError ? <p className="text-sm text-destructive">{fetchError}</p> : null}
        {notifyNote ? <p className="text-sm text-gold" role="status">{notifyNote}</p> : null}

        {mode === "live" && tracked.length > 0 && tab !== "wallets" ? (
          <WalletFilter
            wallets={tracked}
            positions={allLivePositions}
            spot={live?.spot ?? []}
            active={activeFilter}
            onSelect={setWalletFilter}
          />
        ) : null}

        {tab !== "wallets" ? <ViewFilterBar filter={activeView} options={viewOptions} onChange={setViewFilter} /> : null}

        {mode === "live" && tracked.length === 0 && tab !== "wallets" ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            No wallets yet.{" "}
            <button type="button" className="text-azure hover:underline" onClick={() => setTab("wallets")}>
              Sign in or paste an address
            </button>{" "}
            to load your positions.
          </p>
        ) : null}

        {waiting ? <p className="text-sm text-muted-foreground">Reading positions across your wallets…</p> : null}

        {tab === "overview" ? (
          <OverviewTab
            rows={book.rows}
            spot={spot}
            alerts={alerts}
            blendedApy={book.blendedApy}
            thresholds={desk.thresholds}
            example={mode === "example"}
            // History follows the wallet filter but not chain, app or type filters.
            history={filtered ? [] : history}
            hideDust={prefs.hideDust}
            onHideDust={(hideDust) => setPrefs({ hideDust })}
            onOpenAlerts={() => setTab("portfolio")}
            onOpenPosition={openPosition}
            onPickApp={(app) => setViewFilter({ ...activeView, app })}
          />
        ) : null}

        {tab === "portfolio" ? (
          <PortfolioTab
            rows={book.rows}
            spot={spot}
            btcDelta={book.totalBtcDelta}
            history={history}
            example={mode === "example"}
            thresholds={desk.thresholds}
            onOpenPosition={openPosition}
            positions={
              <section className="grid grid-cols-1 gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">Positions</h2>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(null);
                      setPreset("alpend");
                      setDialogOpen(true);
                    }}
                  >
                    Add manual book
                  </Button>
                </div>
                {!waiting && !hasLiveBook ? (
                  <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                    No positions in this view. Alpend on Canton always needs the manual form.
                  </p>
                ) : null}
                {lpCount > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {lpCount} Uniswap liquidity position{lpCount === 1 ? " has" : "s have"} PnL, impermanent loss, fees and gas on{" "}
                    <button type="button" className="text-azure hover:underline" onClick={() => setTab("liquidity")}>
                      Liquidity
                    </button>
                    .
                  </p>
                ) : null}
                {otherCount > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {otherCount} staking, liquidity and other position{otherCount === 1 ? " is" : "s are"} listed by app on{" "}
                    <button type="button" className="text-azure hover:underline" onClick={() => setTab("overview")}>
                      Overview
                    </button>
                    .
                  </p>
                ) : null}
                {lendingRows.map((row) => (
                  <PositionCard
                    key={row.position.id}
                    row={row}
                    thresholds={desk.thresholds}
                    target={row.position.targetHedgeRatio ?? desk.thresholds.defaultTargetHedge}
                    onTarget={(value) =>
                      patch({
                        hedgeTargets: { ...desk.hedgeTargets, [row.position.id]: value },
                      })
                    }
                    onEdit={
                      row.position.source === "manual"
                        ? () => {
                            setEditing(row.position);
                            setPreset(row.position.protocol);
                            setDialogOpen(true);
                          }
                        : undefined
                    }
                    onDelete={
                      row.position.source === "manual"
                        ? () => patch({ manual: desk.manual.filter((item) => item.id !== row.position.id) })
                        : undefined
                    }
                  />
                ))}
                {book.underwater.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Underwater books are listed above and left out of blended leverage and blended net APY.
                  </p>
                ) : null}
              </section>
            }
            risk={
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <ScenarioPanel
                  volatileUnderlyings={volatileUnderlyings}
                  stableUnderlyings={stableUnderlyings}
                  shocks={shocks}
                  onShock={(key, value) => setShocks((current) => ({ ...current, [key]: value }))}
                  equity={scenario.after.equity}
                  pnl={scenario.pnl}
                  leverage={scenario.after.blendedLeverage}
                  hedge={scenario.after.rows.length === 1 ? scenario.after.rows[0].metrics.notionalHedgeRatio : notionalOf(scenario.after)}
                  health={scenario.after.rows.length === 1 ? scenario.after.rows[0].metrics.healthFactor : null}
                  delta={scenario.after.totalBtcDelta}
                  beforeApy={book.blendedApy}
                  multi={scenario.after.rows.length !== 1}
                  rows={scenario.positions.map((item) => ({
                    label: item.position.label,
                    pnl: item.pnl,
                    leverage: item.after.leverage,
                    hedge: item.after.notionalHedgeRatio,
                    health: item.after.healthFactor,
                    distance: item.after.liquidationDistance,
                  }))}
                />
                <AlertsPanel
                  alerts={alerts}
                  thresholds={desk.thresholds}
                  onChange={(thresholds) => patch({ thresholds })}
                  onOpen={openPosition}
                />
              </div>
            }
          />
        ) : null}

        {tab === "liquidity" ? (
          <LiquidityTab
            rows={book.rows}
            example={mode === "example"}
            loading={loading}
            status={mode === "live" ? (live?.protocols.find((protocol) => protocol.id === "uniswap") ?? null) : null}
            onOpenWallets={() => setTab("wallets")}
          />
        ) : null}

        {tab === "advisor" ? (
          <AdvisorTab
            rows={book.rows}
            spot={spot}
            betas={betas}
            betaError={mode === "live" ? betaError : null}
            btcPrice={btcPrice > 0 ? btcPrice : 0}
            thresholds={desk.thresholds}
            goals={desk.goals}
            hedgeTargets={desk.hedgeTargets}
            leverageTargets={desk.leverageTargets}
            example={mode === "example"}
            onGoals={(goals) => patch({ goals })}
            onThresholds={(thresholds) => patch({ thresholds })}
            onHedgeTarget={(id, value) => patch({ hedgeTargets: withTarget(desk.hedgeTargets, id, value) })}
            onLeverageTarget={(id, value) => patch({ leverageTargets: withTarget(desk.leverageTargets, id, value) })}
          />
        ) : null}

        {tab === "wallets" ? (
          <div className="grid grid-cols-1 gap-5">
            <Panel className="grid gap-4">
              <SectionLabel>Your account</SectionLabel>
              <AccountWallets state={accountState} />
              {accountId ? <SyncNote status={sync.status} error={sync.error} /> : null}
            </Panel>
            <AddressBar
              accountWallets={tracked.filter((wallet) => wallet.source === "account")}
              pasted={desk.pasted}
              disabled={mode === "example"}
              loading={loading}
              onChange={(pasted, reload) => {
                if (!reload) return patch({ pasted });
                // Switching to Live loads the book; already Live, load it with the new list.
                if (desk.mode !== "live") return patch({ pasted, mode: "live" });
                patch({ pasted });
                void refresh(pasted);
              }}
              onRefresh={() => {
                if (desk.mode !== "live") patch({ mode: "live" });
                else void refresh(desk.pasted);
              }}
            />
            <ManualBalances
              balances={desk.manualSpot}
              missing={manualPrices.missing.filter((symbol) => desk.manualSpot.some((b) => !b.fixedPrice && b.symbol.toUpperCase() === symbol))}
              priceError={manualPrices.error}
              // Read the desk fresh: a new balance waits on a price lookup, and the desk may move meanwhile.
              onChange={(manualSpot) => commitDesk({ ...currentDesk(), manualSpot, mode: "live" })}
            />
            <Panel className="grid gap-3">
              <SectionLabel>Protocols</SectionLabel>
              <ProtocolRow
                live={mode === "live" ? live : null}
                loading={loading}
                onManual={(id) => {
                  setEditing(null);
                  setPreset(id);
                  setDialogOpen(true);
                }}
              />
              {bookMissing.length ? (
                <p className="text-xs text-gold" role="status">
                  No live price found for {bookMissing.join(", ")} in your manual books, so {bookMissing.length === 1 ? "it keeps" : "they keep"} the
                  last price. Edit the book to type a price.
                </p>
              ) : null}
              {(mode === "live" ? (live?.spotNotes ?? []) : []).map((note) => (
                <p key={note} className="text-xs text-muted-foreground">{note}</p>
              ))}
              <p className="text-xs text-muted-foreground">
                {mode === "example"
                  ? "Example marks are fixed so the sample book does not jump when the market does."
                  : btcPrice > 0
                    ? `BTC ${formatUsd(btcPrice)} from DefiLlama at ${priceTimestampLabel(live?.priceTimestamp ?? null)}. Position USD uses each protocol's own prices.`
                    : `BTC price unavailable${live?.priceError ? `: ${live.priceError}` : ""}.`}
              </p>
            </Panel>
          </div>
        ) : null}
      </main>

      <footer className="mx-auto grid w-full max-w-7xl gap-2 px-4 pb-8 text-xs text-muted-foreground">
        <p>Read-only. Nothing here moves funds; signing in signs a message, never a transaction.</p>
        <p>
          DeFi University LLC provides educational content only. We do not provide financial advice, investment recommendations, or portfolio
          management services. All digital asset education involves high risk. Past performance is not indicative of future results.
        </p>
      </footer>

      <PositionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        presetProtocol={preset}
        onSave={(position) => {
          // Read the desk fresh: saving waits on a price lookup, and the desk may move meanwhile.
          const current = currentDesk();
          commitDesk({
            ...current,
            mode: "live",
            manual: current.manual.some((item) => item.id === position.id)
              ? current.manual.map((item) => (item.id === position.id ? position : item))
              : [...current.manual, position],
          });
        }}
      />
    </div>
  );
}
