/** Numbers, money, percents and dates as the reader's locale writes them; `–` for none. */
export const fmt = {
    num(value: number | null | undefined, digits = 0): string {
        return value == null || Number.isNaN(value)
            ? '–'
            : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
    },
    money(value: number | null | undefined, currency = 'USD', digits = 0): string {
        return value == null || Number.isNaN(value)
            ? '–'
            : new Intl.NumberFormat(undefined, {
                  style: 'currency',
                  currency,
                  maximumFractionDigits: digits,
              }).format(value);
    },
    /** a fraction: 0.12 is 12% */
    pct(value: number | null | undefined, digits = 1): string {
        return value == null || Number.isNaN(value)
            ? '–'
            : new Intl.NumberFormat(undefined, {
                  style: 'percent',
                  maximumFractionDigits: digits,
              }).format(value);
    },
    date(
        value: string | number | Date | null | undefined,
        style: 'short' | 'medium' | 'long' = 'medium',
    ): string {
        if (value == null || value === '') return '–';
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime())
            ? String(value)
            : new Intl.DateTimeFormat(undefined, { dateStyle: style }).format(date);
    },
};

/** The total of a numeric field; values that are not numbers count as 0. */
export function sum<T extends object>(rows: readonly T[], field: keyof T): number {
    return rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
}

/** `[key, total]` per distinct value of `key`, in first-seen order. */
export function groupSum<T extends object>(
    rows: readonly T[],
    key: keyof T,
    field: keyof T,
): [string, number][] {
    const totals = new Map<string, number>();
    for (const row of rows) {
        const k = String(row[key]);
        totals.set(k, (totals.get(k) ?? 0) + (Number(row[field]) || 0));
    }
    return [...totals.entries()];
}

/** The distinct values of a field, sorted. */
export function uniq<T extends object>(rows: readonly T[], field: keyof T): string[] {
    return [...new Set(rows.map((row) => String(row[field])))].sort();
}
