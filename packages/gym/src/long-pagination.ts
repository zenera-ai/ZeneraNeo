export interface LongPaginationConfig {
    /** Number of pages at the configured reference size. */
    pages: number;

    /** Number of records per page used to determine the target. */
    pageSize: number;
}

export type LongPaginationPolicy = Readonly<Record<string, LongPaginationConfig>>;

export function validateLongPagination(config: LongPaginationConfig): void {
    const { pages, pageSize } = config;

    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) {
        throw new Error('long pagination pages must be an integer between 1 and 1000');
    }

    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new Error('long pagination pageSize must be an integer between 1 and 500');
    }

    const records = pages * pageSize;

    if (records > 5000) {
        throw new Error('long pagination cannot require more than 5000 records');
    }
}
