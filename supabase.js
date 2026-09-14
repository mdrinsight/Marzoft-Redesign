/* MARZOFT — browser-side Supabase connector */

(() => {
    'use strict';

    const SUPABASE_URL = 'https://thkmhncbievuqlcbtzyj.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_8IKur53fQm-piPGMD45dDQ_MqEA8hQd'; // <-- PASTE YOUR LONG eyJ... KEY HERE

    const unavailable = (message = 'Supabase is not configured yet.') => ({ data: null, error: new Error(message) });

    let client = null;
   if (window.supabase) {
        client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { 
                persistSession: true, 
                autoRefreshToken: true, 
                detectSessionInUrl: true,
                storageKey: 'marzoft-auth-token'
            }
        });
    } else {
        console.error("Supabase library failed to load from the CDN.");
    }

    const needClient = () => client ? null : unavailable();
    
    const getUser = async () => {
        const missing = needClient();
        if (missing) return missing;
        return client.auth.getUser();
    };

    const requireUser = async () => {
        const result = await getUser();
        if (result.error) throw result.error;
        const user = result.data?.user;
        if (!user) throw new Error('Please sign in before continuing.');
        return user;
    };

    const rpc = async (name, params = {}) => {
        const missing = needClient();
        if (missing) return missing;
        return client.rpc(name, params);
    };

    const BROADCAST_READ_META_KEY = 'marzoft_broadcast_read_at';
    const BROADCAST_READ_CACHE_PREFIX = 'marzoft_broadcast_read_at:';
    const BROADCAST_SYNC_KEY = 'marzoft_broadcast_sync';

    const validIsoDate = (value) => {
        if (!value || Number.isNaN(Date.parse(value))) return null;
        return new Date(value).toISOString();
    };

    const latestIsoDate = (...values) => values
        .map(validIsoDate)
        .filter(Boolean)
        .sort()
        .pop() || null;

    const broadcastCacheKey = (userId) => `${BROADCAST_READ_CACHE_PREFIX}${userId}`;

    const readCachedBroadcastDate = (userId) => {
        try { return validIsoDate(localStorage.getItem(broadcastCacheKey(userId))); }
        catch { return null; }
    };

    const cacheBroadcastDate = (userId, readAt) => {
        try {
            localStorage.setItem(broadcastCacheKey(userId), readAt);
            localStorage.setItem(BROADCAST_SYNC_KEY, JSON.stringify({ userId, readAt, at: Date.now() }));
        } catch { /* Storage can be unavailable in private browsing contexts. */ }

        window.dispatchEvent(new CustomEvent('marzoft:broadcast-read-state', {
            detail: { userId, readAt }
        }));
    };

    const legacyBroadcastDate = (broadcasts, userId) => {
        try {
            const readIds = JSON.parse(localStorage.getItem('marzoft_read_broadcasts') || '[]');
            if (!Array.isArray(readIds) || !readIds.length) return null;
            const legacyOwnerKey = 'marzoft_read_broadcasts_migration_owner';
            const migrationOwner = localStorage.getItem(legacyOwnerKey);
            if (migrationOwner && migrationOwner !== userId) return null;
            if (!migrationOwner) localStorage.setItem(legacyOwnerKey, userId);
            const readSet = new Set(readIds.map(String));
            return latestIsoDate(...broadcasts
                .filter((broadcast) => readSet.has(String(broadcast.id)))
                .map((broadcast) => broadcast.created_at));
        } catch { return null; }
    };

    const listBroadcasts = () => needClient() || client
        .from('broadcasts')
        .select('id,title,message,created_at')
        .order('created_at', { ascending: false });

    const getBroadcastState = async ({ user: suppliedUser } = {}) => {
        try {
            const user = suppliedUser || await requireUser();
            const result = await listBroadcasts();
            if (result.error) return { data: null, error: result.error };

            const broadcasts = result.data || [];
            const backendReadAt = validIsoDate(user.user_metadata?.[BROADCAST_READ_META_KEY]);
            const cachedReadAt = readCachedBroadcastDate(user.id);
            const legacyReadAt = legacyBroadcastDate(broadcasts, user.id);
            const readAt = latestIsoDate(backendReadAt, cachedReadAt, legacyReadAt);
            const unread = broadcasts.filter((broadcast) => {
                const createdAt = validIsoDate(broadcast.created_at);
                return createdAt && (!readAt || createdAt > readAt);
            });

            // Move the dashboard's former local read marker into the authenticated
            // user's Supabase metadata without creating a second notification feed.
            if (legacyReadAt && (!backendReadAt || legacyReadAt > backendReadAt)) {
                client.auth.updateUser({ data: { [BROADCAST_READ_META_KEY]: legacyReadAt } })
                    .then(({ error }) => {
                        if (error) return;
                        cacheBroadcastDate(user.id, legacyReadAt);
                        try {
                            localStorage.removeItem('marzoft_read_broadcasts');
                            localStorage.removeItem('marzoft_read_broadcasts_migration_owner');
                        } catch { /* The backend read marker has already been saved. */ }
                    })
                    .catch(() => { /* The legacy marker remains available for a later retry. */ });
            }

            return {
                data: { user, broadcasts, unread, unreadCount: unread.length, readAt },
                error: null
            };
        } catch (error) {
            return { data: null, error };
        }
    };

    const markBroadcastsRead = async (broadcasts = []) => {
        try {
            const user = await requireUser();
            let items = Array.isArray(broadcasts) ? broadcasts : [];
            if (!items.length) {
                const result = await listBroadcasts();
                if (result.error) return { data: null, error: result.error };
                items = result.data || [];
            }

            const readAt = latestIsoDate(...items.map((broadcast) => broadcast.created_at));
            if (!readAt) return { data: { readAt: null }, error: null };

            const { data, error } = await client.auth.updateUser({
                data: { [BROADCAST_READ_META_KEY]: readAt }
            });
            if (error) return { data: null, error };

            cacheBroadcastDate(user.id, readAt);
            return { data: { user: data?.user || user, readAt }, error: null };
        } catch (error) {
            return { data: null, error };
        }
    };

    const subscribeToBroadcasts = (callback) => {
        if (!client || typeof callback !== 'function') return () => {};
        const channel = client
            .channel(`marzoft-broadcasts-${Math.random().toString(36).slice(2)}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'broadcasts' }, callback)
            .subscribe();
        return () => { client.removeChannel(channel); };
    };

    const onBroadcastReadStateChange = (userId, callback) => {
        if (!userId || typeof callback !== 'function') return () => {};
        const eventHandler = (event) => {
            if (!event.detail || event.detail.userId === userId) callback(event.detail || {});
        };
        const storageHandler = (event) => {
            if (event.key !== BROADCAST_SYNC_KEY) return;
            try {
                const detail = JSON.parse(event.newValue || '{}');
                if (detail.userId === userId) callback(detail);
            } catch { /* Ignore unrelated or malformed storage changes. */ }
        };
        window.addEventListener('marzoft:broadcast-read-state', eventHandler);
        window.addEventListener('storage', storageHandler);
        return () => {
            window.removeEventListener('marzoft:broadcast-read-state', eventHandler);
            window.removeEventListener('storage', storageHandler);
        };
    };

    const api = {
        client,
        isConfigured: () => Boolean(client),

        signInWithGoogle({ redirectTo } = {}) {
            return needClient() || client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
        },
        signUpWithEmail({ email, password, metadata = {}, redirectTo } = {}) {
            return needClient() || client.auth.signUp({ email, password, options: { data: metadata, emailRedirectTo: redirectTo } });
        },
        signInWithEmail({ email, password } = {}) {
            return needClient() || client.auth.signInWithPassword({ email, password });
        },
        signOut() {
            return needClient() || client.auth.signOut();
        },

        // Analytics Tracking (Silent)
        track(eventType, path = window.location.pathname) {
            if(!client) return;
            client.from('analytics').insert({ event_type: eventType, path }).then(); // Fire and forget
        },

        async saveProjectRequest(payload = {}) {
            try {
                const user = await requireUser();
                const req = await client.from('project_requests').insert({
                    client_id: user.id, project_type: payload.project_type || null, goals: payload.goals || null,
                    description: payload.description || null, budget: payload.budget || null,
                    name: payload.name || user.user_metadata?.full_name || null, email: payload.email || user.email || null,
                    whatsapp: payload.whatsapp || null, status: 'new'
                }).select().single();
                
                // Track Conversion!
                if(!req.error) this.track('conversion', 'project_started');
                return req;
            } catch (error) { return { data: null, error }; }
        },

        async getMyProjectRequests() {
            try {
                const user = await requireUser();
                return await client.from('project_requests').select('*').eq('client_id', user.id).order('created_at', { ascending: false });
            } catch (error) { return { data: null, error }; }
        },

        listReviews() {
            return needClient() || client.from('reviews').select('*').eq('published', true).order('created_at', { ascending: false }).limit(50);
        },

        listBroadcasts,
        getBroadcastState,
        markBroadcastsRead,
        subscribeToBroadcasts,
        onBroadcastReadStateChange,

        async addReview(payload = {}) {
            if (needClient()) return needClient();
            const userResult = await client.auth.getUser();
            return client.from('reviews').insert({
                client_id: userResult.data?.user?.id || null, name: payload.name || 'Marzoft client',
                business: payload.business || null, project_type: payload.project_type || null,
                rating: Math.max(1, Math.min(5, Number(payload.rating) || 5)), review_text: String(payload.review_text || '').trim(), published: false
            }).select().single();
        },

        async getWhatsAppConfig() {
            const missing = needClient();
            if (missing) return missing;
            const { data, error } = await client.from('site_settings')
                .select('key, value')
                .in('key', ['whatsapp_number', 'whatsapp_greeting']);
            if (error) return { data: null, error };
            const rawNumber = data?.find((setting) => setting.key === 'whatsapp_number')?.value || null;
            const rawGreeting = data?.find((setting) => setting.key === 'whatsapp_greeting')?.value || null;
            let messages = [];
            if (rawGreeting) {
                try {
                    const parsed = typeof rawGreeting === 'string' ? JSON.parse(rawGreeting) : rawGreeting;
                    messages = (Array.isArray(parsed) ? parsed : [parsed]).map(String).map((message) => message.trim()).filter(Boolean);
                } catch {
                    messages = [String(rawGreeting).trim()].filter(Boolean);
                }
            }
            return {
                data: {
                    number: String(rawNumber || '').replace(/\D/g, '') || null,
                    greeting: messages.join(' '),
                    messages
                },
                error: null
            };
        },

    // Admin / Staff RPCs
        adminListProjectRequests() { return rpc('admin_list_project_requests'); },
        adminListReviews() { return rpc('admin_list_reviews'); },
        adminGetSettings() { return rpc('admin_get_settings'); },
        adminGetAnalytics() { return rpc('admin_get_analytics'); },
        
        adminUpdateProjectRequest(id, patch) { return rpc('admin_update_project_request', { p_request_id: id, p_patch: patch }); },
        adminUpdateReview(id, patch) { return rpc('admin_update_review', { p_review_id: id, p_patch: patch }); },
        adminDeleteReview(id) { return rpc('admin_delete_review', { p_review_id: id }); },
        adminSetSetting(key, value) { return rpc('admin_set_setting', { p_key: key, p_value: value }); },
        adminUpdateRole(userId, newRole) { return rpc('admin_update_role', { p_user_id: userId, p_role: newRole }); },
getPublicSetting(key) { return rpc('get_public_setting', { p_key: key }); },
        setAdminPassword(password) { return rpc('set_admin_password', { new_password: password }); },
        verifyAdminPassword(password) { return rpc('verify_admin_password', { typed_password: password }); },
        isAdmin() { return rpc('is_admin'); },
        isStaffOrAdmin() { return rpc('is_staff_or_admin'); }
    };

    window.marzoftBackend = api;
    window.MarzoftSupabase = api;
    window.supabaseClient = client;

    // Automatically track page view on load
    setTimeout(() => { if(api.track) api.track('page_view'); }, 1000);
})();
