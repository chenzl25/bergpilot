import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";

import { api, getToken, setToken, UNAUTHORIZED_EVENT } from "../api/client";
import { Explorer } from "./Explorer";

export function Layout() {
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });
  const [token, setTokenState] = useState(getToken());

  useEffect(() => {
    const onUnauthorized = () => setTokenState(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const needsToken = info.data?.auth_required && !token;
  // Until the server says whether it needs a token, load nothing else.
  const ready = info.isSuccess;

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          BergPilot
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Catalogs
          </NavLink>
          <NavLink to="/sql">SQL</NavLink>
        </nav>
        <span className="version">{info.data ? `v${info.data.version}` : ""}</span>
      </header>
      {!ready ? (
        <div className="token-prompt">
          {info.isError ? (
            <p className="error">Cannot reach the BergPilot server: {errorMessage(info.error)}</p>
          ) : (
            <p className="muted">Connecting…</p>
          )}
        </div>
      ) : needsToken ? (
        <TokenPrompt
          onSave={(value) => {
            setToken(value);
            setTokenState(value);
            queryClient.invalidateQueries();
          }}
        />
      ) : (
        <div className="body">
          <aside className="sidebar">
            <Explorer />
          </aside>
          <main className="content">
            <Outlet />
          </main>
        </div>
      )}
    </div>
  );
}

function TokenPrompt({ onSave }: { onSave: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="token-prompt">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSave(value.trim());
        }}
      >
        <h2>Access token</h2>
        <p className="muted">
          This BergPilot server requires the token it was started with (BERGPILOT_TOKEN).
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Token"
        />
        <button className="primary" type="submit">
          Continue
        </button>
      </form>
    </div>
  );
}

/** Text for a failed request. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
