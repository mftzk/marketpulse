"use client";

import { useEffect, useState } from "react";

import type { WatchlistDTO } from "@/lib/core/detail";
import { COPY } from "@/lib/copy";
import type { SearchView } from "@/lib/view-types";

import { EmptyState } from "./EmptyState";
import { Panel } from "./Panel";
import { WatchlistTable } from "./WatchlistTable";

export interface WatchlistsViewProps {
  initialLists: WatchlistDTO[];
}

const inputClass =
  "border border-hairline bg-panel-alt px-2 py-1 text-xs text-ink outline-none focus:border-accent";

export function WatchlistsView({ initialLists }: WatchlistsViewProps) {
  const [lists, setLists] = useState<WatchlistDTO[]>(initialLists);
  const [selectedId, setSelectedId] = useState<string | null>(initialLists[0]?.id ?? null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchView["tickers"]>([]);
  const [busy, setBusy] = useState(false);
  const [busyTicker, setBusyTicker] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selected = lists.find((l) => l.id === selectedId) ?? lists[0] ?? null;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 1) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const json = (await response.json()) as { data: SearchView };
        if (active) setResults(json.data.tickers);
      } catch {
        // ignore
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  async function createList() {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/watchlists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), description: newDescription.trim() || undefined }),
      });
      const json = (await response.json()) as { data?: WatchlistDTO; error?: string };
      if (!response.ok || !json.data) {
        setMessage(json.error ?? "Could not create watchlist");
        return;
      }
      setLists((prev) => [...prev, json.data as WatchlistDTO]);
      setSelectedId(json.data.id);
      setNewName("");
      setNewDescription("");
    } catch {
      setMessage("Could not create watchlist");
    } finally {
      setBusy(false);
    }
  }

  async function renameList(id: string) {
    const current = lists.find((l) => l.id === id);
    if (!current) return;
    const next = window.prompt(COPY.watchlists.namePlaceholder, current.name);
    if (!next || next.trim() === current.name) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/watchlists/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next.trim() }),
      });
      const json = (await response.json()) as { data?: WatchlistDTO; error?: string };
      if (!response.ok || !json.data) {
        setMessage(json.error ?? "Could not rename watchlist");
        return;
      }
      setLists((prev) => prev.map((l) => (l.id === id ? (json.data as WatchlistDTO) : l)));
    } finally {
      setBusy(false);
    }
  }

  async function deleteList(id: string) {
    if (!window.confirm(COPY.watchlists.confirmedDelete)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/watchlists/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        setMessage("Could not delete watchlist");
        return;
      }
      setLists((prev) => {
        const next = prev.filter((l) => l.id !== id);
        setSelectedId(next[0]?.id ?? null);
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  async function addTicker(listId: string, ticker: string) {
    setBusyTicker(ticker);
    setMessage(null);
    try {
      const response = await fetch(`/api/watchlists/${listId}/stocks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const json = (await response.json()) as { data?: WatchlistDTO; error?: string };
      if (!response.ok || !json.data) {
        setMessage(json.error ?? "Could not add ticker");
        return;
      }
      setLists((prev) => prev.map((l) => (l.id === listId ? (json.data as WatchlistDTO) : l)));
      setQuery("");
      setResults([]);
    } catch {
      setMessage("Could not add ticker");
    } finally {
      setBusyTicker(null);
    }
  }

  async function removeTicker(listId: string, ticker: string) {
    setBusyTicker(ticker);
    try {
      const response = await fetch(`/api/watchlists/${listId}/stocks/${ticker}`, {
        method: "DELETE",
      });
      if (response.ok || response.status === 204) {
        setLists((prev) =>
          prev.map((l) =>
            l.id === listId
              ? { ...l, stocks: l.stocks.filter((s) => s.ticker !== ticker) }
              : l,
          ),
        );
      } else {
        setMessage("Could not remove ticker");
      }
    } finally {
      setBusyTicker(null);
    }
  }

  return (
    <div className="space-y-3">
      <h1 className="text-sm text-ink">{COPY.watchlists.title}</h1>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Panel title={COPY.watchlists.create}>
            <div className="space-y-2">
              <input
                className={`w-full ${inputClass}`}
                placeholder={COPY.watchlists.namePlaceholder}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                className={`w-full ${inputClass}`}
                placeholder={COPY.watchlists.descriptionPlaceholder}
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void createList()}
                disabled={busy || !newName.trim()}
                className="border border-accent px-2 py-1 text-[11px] uppercase tracking-wide text-accent disabled:opacity-50"
              >
                {COPY.watchlists.create}
              </button>
            </div>
          </Panel>

          <Panel title={COPY.watchlists.title}>
            {lists.length === 0 ? (
              <p className="text-xs text-muted">{COPY.watchlists.empty}</p>
            ) : (
              <ul className="space-y-1">
                {lists.map((list) => (
                  <li key={list.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelectedId(list.id)}
                      className={`min-w-0 flex-1 truncate border px-2 py-1 text-left text-xs ${
                        selected?.id === list.id
                          ? "border-accent text-accent"
                          : "border-transparent text-muted hover:border-hairline hover:text-ink"
                      }`}
                    >
                      {list.name}
                      {list.is_default ? <span className="ml-1 text-[10px] text-muted">default</span> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => void renameList(list.id)}
                      className="border border-hairline px-1.5 py-1 text-[10px] text-muted hover:text-ink"
                    >
                      {COPY.watchlists.rename}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteList(list.id)}
                      className="border border-hairline px-1.5 py-1 text-[10px] text-muted hover:border-negative hover:text-negative"
                    >
                      {COPY.watchlists.delete}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-3">
          {selected ? (
            <>
              <Panel
                title={selected.name}
                action={
                  <span className="font-mono text-[11px] text-muted">
                    {selected.stocks.length} tickers
                  </span>
                }
              >
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      className={`w-full ${inputClass}`}
                      placeholder={COPY.watchlists.addTicker}
                      value={query}
                      onChange={(e) => setQuery(e.target.value.toUpperCase())}
                    />
                    {results.length > 0 && query.trim().length > 0 ? (
                      <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto border border-hairline bg-panel">
                        {results.map((result) => (
                          <li key={result.ticker}>
                            <button
                              type="button"
                              onClick={() => void addTicker(selected.id, result.ticker)}
                              disabled={busyTicker === result.ticker}
                              className="flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-panel-alt disabled:opacity-50"
                            >
                              <span className="font-mono text-ink">{result.ticker}</span>
                              <span className="truncate text-muted">{result.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  {message ? <p className="text-[11px] text-accent">{message}</p> : null}
                  {selected.stocks.length === 0 ? (
                    <EmptyState title={COPY.watchlists.emptyStocks} />
                  ) : (
                    <WatchlistTable
                      stocks={selected.stocks}
                      onRemove={(ticker) => void removeTicker(selected.id, ticker)}
                      busyTicker={busyTicker}
                    />
                  )}
                </div>
              </Panel>
            </>
          ) : (
            <EmptyState title={COPY.watchlists.empty} />
          )}
        </div>
      </div>
    </div>
  );
}
