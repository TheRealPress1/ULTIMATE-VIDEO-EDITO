import { useNavigate } from "@solidjs/router";
import { Show, createResource, createSignal, createEffect, onCleanup } from "solid-js";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { DashboardSurfaceSection } from "./shared";
import { InstagramPublishing } from './instagram-publishing';

/** Pilot connection: credentials enter here and are encrypted by the desktop host, never sent to an agent. */
export function InstagramConnection() {
  const navigate = useNavigate();
  const [state, { mutate, refetch }] = createResource(async () =>
    window.desktop ? mainBridge.call(MAIN_CHANNELS.INSTAGRAM_GET, undefined) : null,
  );
  const [showSetup, setShowSetup] = createSignal(false);
  const [token, setToken] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = createSignal(false);
  const [auth, { mutate: mutateAuth, refetch: refetchAuth }] = createResource(async () => window.desktop
    ? mainBridge.call(MAIN_CHANNELS.INSTAGRAM_AUTH_STATUS, undefined) : null);
  let alive = true;
  onCleanup(() => { alive = false; });
  createEffect(() => {
    if (!auth()?.pending) return;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await mainBridge.call(MAIN_CHANNELS.INSTAGRAM_AUTH_POLL, undefined);
        if (!alive) return;
        mutateAuth(result.status);
        if (result.dashboard) mutate(result.dashboard);
        if (result.status.error) setError(result.status.error);
      } catch { if (alive) setError('Could not check browser sign-in. Cancel and start again.'); }
      finally { polling = false; }
    }, 4000);
    onCleanup(() => clearInterval(timer));
  });
  const browserSignIn = async () => {
    if (pending() || auth()?.pending) return;
    setPending(true); setError(null);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.INSTAGRAM_AUTH_START, undefined);
      await refetchAuth();
      await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: result.authorizationUrl });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start Instagram sign-in.'); }
    finally { setPending(false); }
  };
  const cancelSignIn = async () => {
    try { mutateAuth(await mainBridge.call(MAIN_CHANNELS.INSTAGRAM_AUTH_CANCEL, undefined)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel sign-in.'); }
  };

  const connect = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending() || auth()?.pending || !token().trim()) return;
    setPending(true);
    setError(null);
    const accessToken = token().trim();
    setToken("");
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.INSTAGRAM_CONNECT, { accessToken });
      mutate(result);
      if (result.error || result.status !== "connected" || !result.account) {
        setError(result.error ?? "Could not connect Instagram. Check the account and try again.");
        return;
      }
      setShowSetup(false);
      navigate("/?dashboard=analytics");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect Instagram. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const disconnect = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.INSTAGRAM_DISCONNECT, undefined);
      mutate(result);
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirmDisconnect(false);
      setShowSetup(false);
      setToken("");
    } catch {
      setError("Could not remove the connection. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const openMeta = async () => {
    try {
      await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: "https://developers.facebook.com/apps/" });
    } catch {
      setError("Could not open the browser. Visit developers.facebook.com/apps to set up Instagram access.");
    }
  };

  return (
    <section id="instagram" aria-label="Instagram connection">
      <DashboardSurfaceSection title="Instagram" description="Connect your account to see how your content performs.">
        <Show when={window.desktop} fallback={<p class="text-sm text-muted-foreground">Open the Blackout desktop app to connect Instagram.</p>}>
          <Show when={!state.loading} fallback={<p class="text-sm text-muted-foreground">Loading connection…</p>}>
            <Show when={!state.error} fallback={
              <div class="flex items-center justify-between gap-3">
                <p role="alert" class="text-sm text-muted-foreground">Could not load your Instagram connection.</p>
                <Button variant="secondary" onClick={() => void refetch()}>Try again</Button>
              </div>
            }>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-medium">{state()?.account ? `@${state()!.account!.username}` : "No account connected"}</p>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {state()?.status === "reconnect_required" ? "Your connection has expired. Reconnect to update your stats."
                      : state()?.status === "unavailable" ? "Secure credential storage is unavailable on this device."
                        : state()?.account ? "Read-only analytics · Credentials stored securely on this device"
                          : "Requires an Instagram Creator or Business account."}
                  </p>
                </div>
                <div class="flex gap-2">
                  <Show when={state()?.account}>
                    <Button variant="secondary" onClick={() => navigate("/?dashboard=analytics")}>View analytics</Button>
                    <Button variant="ghost" disabled={pending()} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
                  </Show>
                  <Button variant="secondary" disabled={pending() || auth()?.pending} onClick={() => {
                    setShowSetup(!showSetup());
                    setToken("");
                    setError(null);
                  }}>{state()?.account ? "Update connection" : "Set up connection"}</Button>
                </div>
              </div>
              <div class="flex flex-wrap gap-2 items-center">
                <Button disabled={pending() || auth.loading || !auth()?.configured || auth()?.pending} onClick={() => void browserSignIn()}>Sign in with Instagram</Button>
                <InstagramPublishing account={state()?.account} />
                <Show when={auth()?.pending}><span role="status" class="text-xs text-muted-foreground">Finish authorization in your browser.</span><Button variant="ghost" onClick={() => void cancelSignIn()}>Cancel sign-in</Button></Show>
              </div>
              <Show when={!auth.loading && !auth()?.configured}><p class="text-xs text-muted-foreground">Browser sign-in needs a deployed HTTPS authorization service configured for this build. Developer-token connection remains available below.</p></Show>
              <Show when={auth.error}><p role="alert" class="text-xs text-destructive">Could not load browser sign-in configuration.</p></Show>
              <Show when={confirmDisconnect()}>
                <div class="rounded-lg border border-border p-3 text-sm">
                  <p>Remove this connection and its saved stats from Blackout? Outstanding publishing approvals will pause for review. Your Instagram posts will stay as they are.</p>
                  <div class="mt-3 flex gap-2">
                    <Button variant="destructive" disabled={pending()} onClick={() => void disconnect()}>Remove connection</Button>
                    <Button variant="ghost" disabled={pending()} onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
                  </div>
                </div>
              </Show>
              <Show when={showSetup()}>
                <form onSubmit={(event) => void connect(event)} class="mt-2 flex flex-col gap-4 rounded-lg border border-border p-4">
                  <div>
                    <p class="text-sm font-medium">Developer connection</p>
                    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                      This early build connects with an Instagram API access token from your own Meta app.
                      Browser sign-in is available when this build has a configured authorization service.
                    </p>
                  </div>
                  <ol class="ml-4 list-decimal space-y-2 text-xs leading-relaxed text-muted-foreground">
                    <li>Use a Creator or Business account. Creator accounts are public.</li>
                    <li>In your Meta app, configure Instagram API with Instagram Login and authorize your account for profile and insights access.</li>
                    <li>Paste that account’s access token below. Connecting reads analytics. Publishing requires its own permission and approval in the publishing queue.</li>
                  </ol>
                  <details class="text-xs text-muted-foreground">
                    <summary class="cursor-pointer">Required API permissions</summary>
                    <p class="mt-2 break-words"><code>instagram_business_basic</code> and <code>instagram_business_manage_insights</code>; add <code>instagram_business_content_publish</code> for approved Reel publishing. Use an Instagram user access token, not an app token or Facebook Page token.</p>
                  </details>
                  <TextField value={token()} onChange={setToken}>
                    <TextFieldLabel uiSize="compact">Instagram access token</TextFieldLabel>
                    <TextFieldInput type="password" autocomplete="off" spellcheck={false} placeholder="Paste token here" disabled={pending()} required maxLength={8192} uiSize="compact" />
                  </TextField>
                  <p class="text-xs leading-relaxed text-muted-foreground">Stored using your operating system’s encrypted storage. Never included in chat or analytics tools. You can remove it here at any time.</p>
                  <div class="flex flex-wrap gap-2">
                    <Button type="submit" disabled={pending() || auth()?.pending || !token().trim()}>{pending() ? "Connecting and reading stats…" : "Connect and read stats"}</Button>
                    <Button type="button" variant="ghost" disabled={pending()} onClick={() => void openMeta()}>Open Meta app dashboard</Button>
                    <Button type="button" variant="ghost" disabled={pending()} onClick={() => { setShowSetup(false); setToken(""); }}>Cancel</Button>
                  </div>
                </form>
              </Show>
              <Show when={error() || state()?.error}><p role="alert" class="text-sm text-destructive">{error() || state()?.error}</p></Show>
            </Show>
          </Show>
        </Show>
      </DashboardSurfaceSection>
    </section>
  );
}
