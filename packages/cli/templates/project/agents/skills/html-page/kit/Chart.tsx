import { useEffect, useRef } from 'react';
import { useDarkMode } from './hooks.ts';

/** An ECharts option object: https://echarts.apache.org/en/option.html */
export type ChartOption = Record<string, any>;

/** What a click on a bar, point or slice gives: `name` is its category. */
export interface ChartEvent {
    name: string;
    value: unknown;
    seriesName?: string;
    dataIndex: number;
    data: unknown;
    [key: string]: unknown;
}

interface EChart {
    setOption(option: ChartOption, notMerge?: boolean): void;
    resize(): void;
    dispose(): void;
    on(event: string, handler: (event: ChartEvent) => void): void;
}

// Loaded from the CDN by the page's html; the build adds it when a page uses Chart.
declare const echarts: { init(el: HTMLElement, theme?: string | null): EChart };

const BASE: ChartOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', confine: true },
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
};

/**
 * An ECharts chart that fills its card's width, follows the panel's size and the light/dark
 * scheme, and redraws when `option` changes. Top-level keys of `option` replace the defaults
 * (an axis tooltip, a tight grid); a pie wants `tooltip: { trigger: 'item' }`.
 *
 *   <Chart option={{ xAxis: {…}, yAxis: {…}, series: [{ type: 'bar', data }] }} />
 */
export function Chart({
    option,
    height = 320,
    onClick,
    className,
}: {
    option: ChartOption;
    height?: number | string;
    onClick?: (event: ChartEvent) => void;
    className?: string;
}) {
    const el = useRef<HTMLDivElement>(null);
    const chart = useRef<EChart | null>(null);
    const optionRef = useRef(option);
    optionRef.current = option;
    const clickRef = useRef(onClick);
    clickRef.current = onClick;
    const dark = useDarkMode();

    useEffect(() => {
        const node = el.current!;
        const c = echarts.init(node, dark ? 'dark' : null);
        chart.current = c;
        c.setOption({ ...BASE, ...optionRef.current }, true);
        c.on('click', (event) => clickRef.current?.(event));
        const resize = new ResizeObserver(() => c.resize());
        resize.observe(node);
        return () => {
            resize.disconnect();
            c.dispose();
            chart.current = null;
        };
    }, [dark]);

    useEffect(() => {
        chart.current?.setOption({ ...BASE, ...option }, true);
    }, [option]);

    return <div ref={el} className={`chart ${className ?? ''}`} style={{ height }} />;
}
