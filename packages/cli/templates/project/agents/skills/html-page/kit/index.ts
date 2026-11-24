// The page kit, imported by pages as `@page/kit`. The build bundles it into each page.
import './theme.css';

export { ApiError, api, call, type AnyApi } from './api.ts';
export {
    fetchJson,
    toError,
    useAction,
    useCall,
    useDarkMode,
    useData,
    useHashState,
    type Action,
    type Call,
} from './hooks.ts';
export { fmt, groupSum, sum, uniq } from './format.ts';
export {
    Card,
    ConfirmButton,
    Empty,
    ErrorBox,
    Field,
    Grid,
    Kpi,
    Kpis,
    Loading,
    Page,
    SafeHtml,
    Select,
    Split,
    Toolbar,
    type Option,
} from './components.tsx';
export { Chart, type ChartEvent, type ChartOption } from './Chart.tsx';
export { Table, type Column } from './Table.tsx';
