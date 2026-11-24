import { Component, StrictMode, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

// The build's entry: it mounts the page's default export into #root. Pages never call this.

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    override state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    override componentDidCatch(error: unknown, info: ErrorInfo) {
        console.error(error, info.componentStack);
    }

    override render() {
        const { error } = this.state;
        if (!error) return this.props.children;
        return (
            <main className="page page-narrow">
                <div className="card error" role="alert">
                    <strong>This page hit an error.</strong>
                    <span>{error.message}</span>
                    <button onClick={() => this.setState({ error: null })}>Try again</button>
                </div>
            </main>
        );
    }
}

/** Errors outside rendering (a handler, a promise nobody awaited): shown, not swallowed. */
function reportUncaught() {
    const show = (message: string) => {
        let bar = document.getElementById('page-uncaught');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'page-uncaught';
            bar.className = 'uncaught';
            bar.setAttribute('role', 'alert');
            bar.addEventListener('click', () => bar?.remove());
            document.body.append(bar);
        }
        bar.textContent = `Something went wrong: ${message} (click to dismiss)`;
    };
    window.addEventListener('error', (e) => show(e.message || 'an error'));
    window.addEventListener('unhandledrejection', (e) => {
        const reason: unknown = e.reason;
        show(reason instanceof Error ? reason.message : String(reason));
    });
}

export function mount(App: ComponentType) {
    reportUncaught();
    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <Boundary>
                <App />
            </Boundary>
        </StrictMode>,
    );
}
