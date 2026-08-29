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

        async addReview(payload = {}) {
            if (needClient()) return needClient();
            const userResult = await client.auth.getUser();
            return client.from('reviews').insert({
                client_id: userResult.data?.user?.id || null, name: payload.name || 'Marzoft client',
                business: payload.business || null, project_type: payload.project_type || null,
                rating: Math.max(1, Math.min(5, Number(payload.rating) || 5)), review_text: String(payload.review_text || '').trim(), published: false
            }).select().single();
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
        adminUpdateStaff(userId, newRole, jobTitle) { return rpc('admin_update_staff', { p_user_id: userId, p_role: newRole, p_job_title: jobTitle }); },
        
        isAdmin() { return rpc('is_admin'); },
        isStaffOrAdmin() { return rpc('is_staff_or_admin'); }
    };

    window.marzoftBackend = api;
    window.MarzoftSupabase = api;
    window.supabaseClient = client;

    // Automatically track page view on load
    setTimeout(() => { if(api.track) api.track('page_view'); }, 1000);
})();