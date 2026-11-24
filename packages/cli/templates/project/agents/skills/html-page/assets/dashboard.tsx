// A dashboard: filters, headline numbers, two charts and a table, from data.json beside the page.
// Copy this to <page>/app.tsx and keep the shape: data, then derived rows, then the page.
import { useEffect, useMemo, useState } from 'react';
import {
    Card,
    Chart,
    Empty,
    ErrorBox,
    Grid,
    Kpi,
    Kpis,
    Loading,
    Page,
    Select,
    Table,
    Toolbar,
    fmt,
    groupSum,
    sum,
    uniq,
    useData,
    type Column,
} from '@page/kit';

// ---- The page: replace from here with the real data's fields. ----
// data.json, written by your script: { "title", "subtitle", "source", "rows": [Row, ...] }.
// Live data instead: `const report = useCall(() => api<ReportApi>('api/report').get_data(), []);`
// with get_data() in api/report.api.py returning the same shape (references/python-functions.md).

interface Row {
    date: string;
    category: string;
    region: string;
    amount: number;
}

interface Report {
    title: string;
    subtitle?: string;
    source?: string;
    rows: Row[];
}

export const title = 'Dashboard';

const columns: Column[] = [
    { title: 'Date', field: 'date', headerFilter: 'input', minWidth: 100 },
    { title: 'Category', field: 'category', headerFilter: 'input' },
    { title: 'Region', field: 'region', headerFilter: 'input' },
    {
        title: 'Amount',
        field: 'amount',
        hozAlign: 'right',
        sorter: 'number',
        formatter: (cell: { getValue(): number }) => fmt.num(cell.getValue(), 2),
    },
];

export default function App() {
    const report = useData<Report>('data.json');
    const [category, setCategory] = useState('');
    const [region, setRegion] = useState('');

    const all = report.data?.rows;
    useEffect(() => {
        if (report.data) document.title = report.data.title;
    }, [report.data]);
    const rows = useMemo(
        () =>
            (all ?? []).filter(
                (r) => (!category || r.category === category) && (!region || r.region === region),
            ),
        [all, category, region],
    );
    const byCategory = useMemo(() => {
        const totals = groupSum(rows, 'category', 'amount').sort((a, b) => b[1] - a[1]);
        return {
            xAxis: {
                type: 'category',
                data: totals.map((d) => d[0]),
                axisLabel: { interval: 0, rotate: totals.length > 5 ? 30 : 0 },
            },
            yAxis: { type: 'value' },
            series: [{ type: 'bar', data: totals.map((d) => d[1]) }],
        };
    }, [rows]);
    const overTime = useMemo(() => {
        const totals = groupSum(rows, 'date', 'amount').sort((a, b) => a[0].localeCompare(b[0]));
        return {
            xAxis: { type: 'category', data: totals.map((d) => d[0]) },
            yAxis: { type: 'value' },
            dataZoom: totals.length > 30 ? [{ type: 'inside' }] : [],
            series: [
                {
                    type: 'line',
                    showSymbol: false,
                    areaStyle: { opacity: 0.15 },
                    data: totals.map((d) => d[1]),
                },
            ],
        };
    }, [rows]);

    if (report.error) {
        return (
            <Page title={title}>
                <ErrorBox error={report.error} onRetry={report.reload} />
            </Page>
        );
    }
    if (!report.data || !all) {
        return (
            <Page title={title}>
                <Loading />
            </Page>
        );
    }
    return (
        <Page title={report.data.title} subtitle={report.data.subtitle} footer={report.data.source}>
            <Toolbar>
                <Select
                    label="Category"
                    all="All"
                    value={category}
                    options={uniq(all, 'category')}
                    onChange={setCategory}
                />
                <Select
                    label="Region"
                    all="All"
                    value={region}
                    options={uniq(all, 'region')}
                    onChange={setRegion}
                />
            </Toolbar>

            <Kpis>
                <Kpi label="Total amount" value={fmt.num(sum(rows, 'amount'))} />
                <Kpi label="Rows" value={fmt.num(rows.length)} />
                <Kpi label="Categories" value={fmt.num(uniq(rows, 'category').length)} />
            </Kpis>

            {rows.length === 0 ? (
                <Card>
                    <Empty>No data for these filters.</Empty>
                </Card>
            ) : (
                <Grid>
                    <Card title="Amount by category">
                        <Chart option={byCategory} onClick={(e) => setCategory(e.name)} />
                    </Card>
                    <Card title="Amount over time">
                        <Chart option={overTime} />
                    </Card>
                    <Card title="Rows" wide>
                        <Table data={rows} columns={columns} />
                    </Card>
                </Grid>
            )}
        </Page>
    );
}
