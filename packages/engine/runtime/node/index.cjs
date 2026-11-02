'use strict';

// Who this Zenera run is acting for. The host puts the signed-in user into every
// command's environment as ZEN_USER_*; this reads them.
//
//     const { identity, requireIdentity } = require('zenera');
//     const me = identity(); // null when no one is signed in

function get(name) {
    const value = (process.env[name] || '').trim();
    return value || undefined;
}

function identity() {
    const id = get('ZEN_USER_ID');
    if (!id) {
        return null;
    }
    return {
        id,
        email: get('ZEN_USER_EMAIL'),
        name: get('ZEN_USER_NAME'),
        role: get('ZEN_USER_ROLE'),
        source: get('ZEN_USER_SOURCE') || 'local',
    };
}

class NoIdentityError extends Error {
    constructor() {
        super(
            'this run has no signed-in user (ZEN_USER_ID is not set); ' +
                'outside the Zenera app, start it with: zen run --as <user>',
        );
        this.name = 'NoIdentityError';
    }
}

function requireIdentity() {
    const me = identity();
    if (!me) {
        throw new NoIdentityError();
    }
    return me;
}

module.exports = { identity, requireIdentity, NoIdentityError };
