/*
Copyright 2025 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// 3 (imaginary) interfaces are implemented here:
// - OfflineAvailability (done by registering the sw)
// - UpdateService (see checkForUpdate method, and should also emit events rather than showing confirm dialog here)
// - ConcurrentAccessBlocker (see preventConcurrentSessionAccess method)
export class ServiceWorkerHandler {
    constructor(sessionInfoStorage) {
        this._waitingForReply = new Map();
        this._messageIdCounter = 0;
        this._navigation = null;
        this._registration = null;
        this._registrationPromise = null;
        this._currentController = null;
        this._sessionInfoStorage = sessionInfoStorage;
        this.haltRequests = false;
        this._authData = {};
    }

    setNavigation(navigation) {
        this._navigation = navigation;
    }

    /**
     * Set the access-token and homeserver to be used within the service worker.
     * @param auth An object with accessToken and homeserver
     */
    updateAuthData(auth) {
        if (!auth.accessToken && !auth.homeserver) {
            throw new Error(
                "updateAuthData argument must contain accessToken, homeserver or both!"
            );
        }
        this._authData = { ...this._authData, ...auth };
    }

    registerAndStart(path) {
        this._registrationPromise = (async () => {
            navigator.serviceWorker.addEventListener("message", this);
            navigator.serviceWorker.addEventListener("controllerchange", this);
            this._registration = await navigator.serviceWorker.register(path);
            await navigator.serviceWorker.ready;
            this._currentController = navigator.serviceWorker.controller;
            this._registration.addEventListener("updatefound", this);
            this._registrationPromise = null;
            // do we have a new service worker waiting to activate?
            if (this._registration.waiting && this._registration.active) {
                this._proposeUpdate();
            }
            console.log("Service Worker registered");
        })();
    }

    async _onMessage(event) {
        const { data } = event;
        const replyTo = data.replyTo;
        if (replyTo) {
            const resolve = this._waitingForReply.get(replyTo);
            if (resolve) {
                this._waitingForReply.delete(replyTo);
                resolve(data.payload);
            }
        }
        if (data.type === "hasSessionOpen") {
            const hasOpen =
                this._navigation.observe("session").get() ===
                data.payload.sessionId;
            event.source.postMessage({ replyTo: data.id, payload: hasOpen });
        } else if (data.type === "hasRoomOpen") {
            const hasSessionOpen =
                this._navigation.observe("session").get() ===
                data.payload.sessionId;
            const hasRoomOpen =
                this._navigation.observe("room").get() === data.payload.roomId;
            event.source.postMessage({
                replyTo: data.id,
                payload: hasSessionOpen && hasRoomOpen,
            });
        } else if (data.type === "closeSession") {
            const { sessionId } = data.payload;
            this._closeSessionIfNeeded(sessionId).finally(() => {
                event.source.postMessage({ replyTo: data.id });
            });
        } else if (data.type === "haltRequests") {
            // this flag is read in fetch.js
            this.haltRequests = true;
            event.source.postMessage({ replyTo: data.id });
        } else if (data.type === "openRoom") {
            this._navigation.push("room", data.payload.roomId);
        } else if (data.type === "getAuthInfo") {
            event.source.postMessage({
                replyTo: data.id,
                payload: this._authData,
            });
        }
    }

    _closeSessionIfNeeded(sessionId) {
        const currentSession = this._navigation?.path.get("session");
        if (sessionId && currentSession?.value === sessionId) {
            return new Promise((resolve) => {
                const unsubscribe = this._navigation.pathObservable.subscribe(
                    (path) => {
                        const session = path.get("session");
                        if (!session || session.value !== sessionId) {
                            unsubscribe();
                            resolve();
                        }
                    }
                );
                this._navigation.push("session");
            });
        } else {
            return Promise.resolve();
        }
    }

    async _proposeUpdate() {
        if (document.hidden) {
            return;
        }
        const version = await this._sendAndWaitForReply(
            "version",
            null,
            this._registration.waiting
        );
        const isSdk = DEFINE_IS_SDK;
        const isDev = this.version === "develop";
        // Don't ask for confirmation when being used as an sdk/ when being run in dev server
        if (
            isSdk ||
            isDev ||
            confirm(
                `Version ${version.version} (${version.buildHash}) is available. Reload to apply?`
            )
        ) {
            console.log("Service Worker has been updated!");
            // prevent any fetch requests from going to the service worker
            // from any client, so that it is not kept active
            // when calling skipWaiting on the new one
            await this._sendAndWaitForReply("haltRequests");
            // only once all requests are blocked, ask the new
            // service worker to skipWaiting
            this._send("skipWaiting", null, this._registration.waiting);
        }
    }

    handleEvent(event) {
        switch (event.type) {
            case "message":
                this._onMessage(event);
                break;
            case "updatefound":
                this._registration.installing.addEventListener(
                    "statechange",
                    this
                );
                break;
            case "statechange": {
                if (event.target.state === "installed") {
                    this._proposeUpdate();
                    event.target.removeEventListener("statechange", this);
                }
                break;
            }
            case "controllerchange":
                if (!this._currentController) {
                    // Clients.claim() in the SW can trigger a controllerchange event
                    // if we had no SW before. This is fine,
                    // and now our requests will be served from the SW.
                    this._currentController =
                        navigator.serviceWorker.controller;
                } else {
                    // active service worker changed,
                    // refresh, so we can get all assets
                    // (and not only some if we would not refresh)
                    // up to date from it
                    document.location.reload();
                }
                break;
        }
    }

    async _send(type, payload, worker = undefined) {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        if (!worker) {
            worker = this._registration.active;
        }
        worker.postMessage({ type, payload });
    }

    async _sendAndWaitForReply(type, payload, worker = undefined) {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        if (!worker) {
            worker = this._registration.active;
        }
        this._messageIdCounter += 1;
        const id = this._messageIdCounter;
        const promise = new Promise((resolve) => {
            this._waitingForReply.set(id, resolve);
        });
        worker.postMessage({ type, id, payload });
        return await promise;
    }

    async checkForUpdate() {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        this._registration.update();
    }

    get version() {
        return DEFINE_VERSION;
    }

    get buildHash() {
        return DEFINE_GLOBAL_HASH;
    }

    async preventConcurrentSessionAccess(sessionId) {
        return this._sendAndWaitForReply("closeSession", { sessionId });
    }

    async getRegistration() {
        if (this._registrationPromise) {
            await this._registrationPromise;
        }
        return this._registration;
    }
}
