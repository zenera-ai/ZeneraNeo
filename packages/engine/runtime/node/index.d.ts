/** The signed-in user a Zenera run is acting for. */
export interface Identity {
    id: string;
    email?: string;
    name?: string;
    role?: string;
    /** IANA time zone, e.g. `Europe/Berlin` */
    timeZone?: string;
    /** https URL of the user's avatar */
    picture?: string;
    /** `host`: the application authenticated them; `local`: only stated on this machine */
    source: 'host' | 'local' | string;
}

/** The user this run acts for, or `null` when there is none. */
export function identity(): Identity | null;

/** The user this run acts for; throws `NoIdentityError` when there is none. */
export function requireIdentity(): Identity;

export class NoIdentityError extends Error {}
