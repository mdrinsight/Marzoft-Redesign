/*
  MARZOFT — browser-side Supabase connector

  1. Paste your Supabase Project URL and anon/public key below.
  2. Never put a service_role key, database password, or admin password here.
  3. Keep RLS enabled in Supabase. Admin actions below call protected RPC functions.
*/

(() => {
    'use strict';

    const SUPABASE_URL = 'https://thkmhncbievuqlcbtzyj.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_8IKur53fQm-piPGMD45dDQ_MqEA8hQd';
    const configured = /^https:\/\/.+\.supabase\.co$/i.test(SUPABASE_URL)
        && !SUPABASE_ANON_KEY.startsWith('PASTE_');

    const unavailable = (message = 'Supabase is not configured yet.') => ({
        data: null,
        error: new Error(message)
    });

    let client = null;
    if (configured && window.supabase?.createClient) {
        client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        });
    } else if (!configured) {
        console.info('[Marzoft] Add the public Supabase URL and anon key in supabase.js to enable the live backend.');
    } else {
        console.warn('[Marzoft] Supabase library did not load. Check the script tag in index (7).html.');
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

    const api = {
        client,
        isConfigured: () => Boolean(client),

        signInWithGoogle({ redirectTo } = {}) {
            const missing = needClient();
            return missing || client.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo }
            });
        },

        signUpWithEmail({ email, password, metadata = {}, redirectTo } = {}) {
            const missing = needClient();
            return missing || client.auth.signUp({
                email,
                password,
                options: { data: metadata, emailRedirectTo: redirectTo }
            });
        },

        signInWithEmail({ email, password } = {}) {
            const missing = needClient();
            return missing || client.auth.signInWithPassword({ email, password });
        },

        signOut() {
            const missing = needClient();
            return missing || client.auth.signOut();
        },

        async saveProjectRequest(payload = {}) {
            try {
                const user = await requireUser();
                return await client.from('project_requests').insert({
                    client_id: user.id,
                    project_type: payload.project_type || null,
                    goals: payload.goals || null,
                    description: payload.description || null,
                    budget: payload.budget || null,
                    name: payload.name || user.user_metadata?.full_name || null,
                    email: payload.email || user.email || null,
                    whatsapp: payload.whatsapp || null,
                    status: 'new'
                }).select().single();
            } catch (error) {
                return { data: null, error };
            }
        },

        async getMyProjectRequests() {
            try {
                const user = await requireUser();
                return await client.from('project_requests')
                    .select('*')
                    .eq('client_id', user.id)
                    .order('created_at', { ascending: false });
            } catch (error) {
                return { data: null, error };
            }
        },

        listReviews() {
            const missing = needClient();
            return missing || client.from('reviews')
                .select('*')
                .eq('published', true)
                .order('created_at', { ascending: false })
                .limit(50);
        },

        async addReview(payload = {}) {
            const missing = needClient();
            if (missing) return missing;
            const userResult = await client.auth.getUser();
            const user = userResult.data?.user || null;
            return client.from('reviews').insert({
                client_id: user?.id || null,
                name: payload.name || 'Marzoft client',
                business: payload.business || null,
                project_type: payload.project_type || null,
                rating: Math.max(1, Math.min(5, Number(payload.rating) || 5)),
                review_text: String(payload.review_text || '').trim(),
                published: false
            }).select().single();
        },

        // These call protected database RPC functions. They must verify the signed-in
        // user's admin role inside Supabase before reading or changing anything.
        adminListProjectRequests() { return rpc('admin_list_project_requests'); },
        adminListReviews() { return rpc('admin_list_reviews'); },
        adminGetSettings() { return rpc('admin_get_settings'); },
        adminUpdateProjectRequest(id, patch) {
            return rpc('admin_update_project_request', { p_request_id: id, p_patch: patch });
        },
        adminUpdateReview(id, patch) {
            return rpc('admin_update_review', { p_review_id: id, p_patch: patch });
        },
        adminDeleteReview(id) { return rpc('admin_delete_review', { p_review_id: id }); },
        adminSetSetting(key, value) {
            return rpc('admin_set_setting', { p_key: key, p_value: value });
        },
        isAdmin() { return rpc('is_admin'); }
    };

    window.marzoftBackend = api;
    window.MarzoftSupabase = api;
    window.supabaseClient = client;
})();