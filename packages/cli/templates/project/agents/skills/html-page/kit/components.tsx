import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { fmt } from './format.ts';

/**
 * The page: a heading, the content, and a footer naming the source. `narrow` (900 px) suits
 * an app or a list, `wide` (1400 px) a dashboard.
 */
export function Page({
    title,
    subtitle,
    actions,
    footer,
    width = 'wide',
    children,
}: {
    title?: ReactNode;
    subtitle?: ReactNode;
    /** buttons or a "signed in as" beside the heading */
    actions?: ReactNode;
    footer?: ReactNode;
    width?: 'narrow' | 'wide';
    children?: ReactNode;
}) {
    return (
        <main className={`page page-${width}`}>
            {(title || subtitle || actions) && (
                <header className="page-header">
                    <div className="page-heading">
                        {title && <h1>{title}</h1>}
                        {subtitle && <p>{subtitle}</p>}
                    </div>
                    {actions && <div className="row">{actions}</div>}
                </header>
            )}
            {children}
            {footer && <footer className="page-footer">{footer}</footer>}
        </main>
    );
}

/** The controls of the page, in one row that wraps on a narrow panel. */
export function Toolbar({ children }: { children?: ReactNode }) {
    return <section className="card toolbar">{children}</section>;
}

/** A labelled control: `<Field label="From"><input type="date" … /></Field>`. */
export function Field({ label, children }: { label: ReactNode; children?: ReactNode }) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
        </label>
    );
}

export type Option = string | { value: string; label: string };

/** A select over `options`; `all` adds a first option with value `''` ("All"). */
export function Select({
    label,
    value,
    options,
    onChange,
    all,
}: {
    label?: string;
    value: string;
    options: readonly Option[];
    onChange: (value: string) => void;
    all?: string;
}) {
    const select = (
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
            {all !== undefined && <option value="">{all}</option>}
            {options.map((o) => {
                const { value: v, label: l } = typeof o === 'string' ? { value: o, label: o } : o;
                return (
                    <option key={v} value={v}>
                        {l}
                    </option>
                );
            })}
        </select>
    );
    return label ? <Field label={label}>{select}</Field> : select;
}

/** A row of headline numbers. */
export function Kpis({ children }: { children?: ReactNode }) {
    return <section className="kpis">{children}</section>;
}

/** One headline number: `value` already formatted, `delta` a fraction (0.12 is +12%). */
export function Kpi({
    label,
    value,
    delta,
    hint,
}: {
    label: ReactNode;
    value: ReactNode;
    delta?: number | null;
    hint?: ReactNode;
}) {
    return (
        <div className="card kpi">
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
            {delta != null && (
                <div className={`kpi-delta ${delta >= 0 ? 'up' : 'down'}`}>
                    {delta >= 0 ? '▲' : '▼'} {fmt.pct(Math.abs(delta))}
                </div>
            )}
            {hint && <div className="kpi-hint">{hint}</div>}
        </div>
    );
}

/** Cards side by side when there is room, one per row when there is not. */
export function Grid({ children, min = 420 }: { children?: ReactNode; min?: number }) {
    return (
        <section className="grid" style={{ '--min': `${min}px` } as CSSProperties}>
            {children}
        </section>
    );
}

/** A box with a heading; `wide` spans the whole row of a Grid. */
export function Card({
    title,
    actions,
    wide,
    className,
    children,
}: {
    title?: ReactNode;
    actions?: ReactNode;
    wide?: boolean;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <section className={['card', wide && 'wide', className].filter(Boolean).join(' ')}>
            {(title || actions) && (
                <div className="card-header">
                    {title && <h2>{title}</h2>}
                    {actions && <div className="row">{actions}</div>}
                </div>
            )}
            {children}
        </section>
    );
}

/** Cards and blocks one under another, with the page's gap. */
export function Stack({ children }: { children?: ReactNode }) {
    return <div className="stack">{children}</div>;
}

/**
 * A list and what is open from it: a message, a record, a form to write a new one.
 *
 * Wide: side by side, `placeholder` on the right while nothing is open.
 * Narrow (the chat's side panel): the list, or - while `detail` is given - only the detail,
 * with a Back button (calling `onBack`) above it.
 *
 * `detail` is null when nothing is open, and whatever is open otherwise: anything the user
 * can open, including a compose or edit form, goes in it, so it is reachable at every width.
 *
 *   <Split
 *       list={<Inbox onOpen={setOpenId} onNew={() => setComposing(true)} />}
 *       detail={composing ? <Compose … /> : openId != null ? <Message id={openId} /> : null}
 *       onBack={() => { setComposing(false); setOpenId(null); }}
 *   />
 */
export function Split({
    list,
    detail,
    onBack,
    placeholder = 'Pick an item to open it.',
    backLabel = 'Back',
}: {
    list: ReactNode;
    /** what is open, or null (or false) when nothing is */
    detail: ReactNode;
    /** closes what is open: the narrow layout's Back button */
    onBack: () => void;
    placeholder?: ReactNode;
    backLabel?: ReactNode;
}) {
    const open = detail != null && detail !== false;
    return (
        <div className={`split${open ? ' split-open' : ''}`}>
            <div className="split-list">{list}</div>
            <div className="split-detail">
                {open ? (
                    <>
                        <button className="split-back" onClick={onBack}>
                            ← {backLabel}
                        </button>
                        {detail}
                    </>
                ) : (
                    <Card>
                        <Empty>{placeholder}</Empty>
                    </Card>
                )}
            </div>
        </div>
    );
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
    return (
        <p className="muted" role="status" aria-busy="true">
            {children}
        </p>
    );
}

/** What there is to say when there is nothing to show: "No orders yet". */
export function Empty({ children = 'Nothing here yet.' }: { children?: ReactNode }) {
    return <p className="muted empty">{children}</p>;
}

/** An error, shown on the page; nothing when there is none. */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    if (!error) return null;
    const message = error instanceof Error ? error.message : String(error);
    return (
        <div className="card error" role="alert">
            <span>{message}</span>
            {onRetry && <button onClick={onRetry}>Try again</button>}
        </div>
    );
}

/**
 * A button that asks for a second click before it acts: the page has no confirm() dialog.
 *
 *   <ConfirmButton onConfirm={() => remove.run(item.id)}>Delete</ConfirmButton>
 */
export function ConfirmButton({
    onConfirm,
    children,
    confirm = 'Sure?',
    className = 'danger',
    disabled,
    timeoutMs = 3000,
}: {
    onConfirm: () => unknown;
    children?: ReactNode;
    /** the label while it waits for the second click */
    confirm?: ReactNode;
    className?: string;
    disabled?: boolean;
    timeoutMs?: number;
}) {
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), timeoutMs);
        return () => clearTimeout(timer);
    }, [armed, timeoutMs]);
    return (
        <button
            className={className}
            disabled={disabled}
            onClick={() => {
                if (!armed) return setArmed(true);
                setArmed(false);
                void onConfirm();
            }}
        >
            {armed ? confirm : children}
        </button>
    );
}

/**
 * HTML from outside - an email body, a fetched article - shown in a sandboxed frame where its
 * scripts cannot run and its links open in a new tab. Never put such HTML in the page itself.
 */
export function SafeHtml({
    html,
    title = 'Content',
    height = 400,
}: {
    html: string;
    title?: string;
    height?: number | string;
}) {
    return (
        <iframe
            className="safe-html"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={`<base target="_blank">${html}`}
            title={title}
            style={{ height }}
        />
    );
}
