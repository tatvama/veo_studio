import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { tr } from "../../lib/i18n";

interface Props { children: ReactNode; /** Changing this (e.g. the route) clears a previous error. */ resetKey?: string }
interface State { error: Error | null }

/**
 * Catches a crash inside one page so the sidebar and everything else keep working.
 * Also handles "the app was updated while you had it open" (a lazy chunk that no longer exists) with a reload prompt.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[page crashed]", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = /dynamically imported module|Importing a module script failed|Loading chunk|Failed to fetch dynamically/i.test(error.message);
    return (
      <div className="flex h-full items-center justify-center p-6" role="alert">
        <div className="anim-rise w-full max-w-md rounded-2xl border border-line bg-panel p-6 text-center shadow-card">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-warn/12 text-warn"><AlertTriangle className="size-6" /></div>
          <h2 className="text-lg font-semibold tracking-tight">{stale ? tr("A new version is available") : tr("This page hit a problem")}</h2>
          <p className="mt-1.5 text-sm text-mute">
            {stale ? tr("Reload to get the latest version of VEO Studio. Your work is saved.") : tr("The rest of the app is fine. Try again, or reload the page.")}
          </p>
          {!stale && <p className="mt-3 truncate rounded-lg bg-raised px-3 py-2 text-left font-mono text-2xs text-dim" title={error.message}>{error.message}</p>}
          <div className="mt-5 flex justify-center gap-2">
            {!stale && (
              <button onClick={() => this.setState({ error: null })} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-raised px-3.5 text-sm font-medium transition-colors hover:bg-hover">
                {tr("Try again")}
              </button>
            )}
            <button onClick={() => window.location.reload()} className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium text-black">
              <RefreshCw className="size-4" />{tr("Reload")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
