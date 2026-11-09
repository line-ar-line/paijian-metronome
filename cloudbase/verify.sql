-- Read-only authorization checks for the deployed Paijian CloudBase PG backend.
-- Run this whole file as ONE statement through the administrator SQL endpoint.
-- No accounts, rows, tables, policies or privileges are created/changed.
-- JWT GUC overrides are transaction-local and restored on completion.
-- Each RPC runs in a subtransaction. Unexpected success raises an exception,
-- rolling back that subtransaction and aborting the entire DO statement.
DO $paijian_guards$
DECLARE
  v_saved_claims text := current_setting('request.jwt.claims', true);
  v_saved_sub text := current_setting('request.jwt.claim.sub', true);
  v_saved_role text := current_setting('request.jwt.claim.role', true);
  v_project constant text := 'fast-junglefowl-d3fqxnq941dd1c4e';
  v_absent_sub text := '__paijian_guard_no_account__';
  v_claims jsonb;
  v_command text;
  v_role text;
  v_table text;
  v_signature text;
  v_function oid;
  v_rpc_checks integer := 0;
  v_acl_checks integer := 0;
  v_rls_checks integer := 0;
BEGIN
  -- Refuse to impersonate any existing account, even if the reserved marker was used.
  IF EXISTS (SELECT 1 FROM auth.users WHERE sub = v_absent_sub) THEN
    RAISE EXCEPTION 'Guard fixture subject already exists; choose another nonexistent marker.';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['public.community_profiles', 'public.community_checkins']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = v_table::regclass AND relrowsecurity) THEN
      RAISE EXCEPTION 'RLS is not enabled on %', v_table;
    END IF;
    v_rls_checks := v_rls_checks + 1;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_table,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'Unexpected direct table privilege: role %, table %', v_role, v_table;
      END IF;
      v_acl_checks := v_acl_checks + 1;
    END LOOP;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF pg_catalog.has_schema_privilege(v_role, 'community_private', 'USAGE,CREATE') THEN
      RAISE EXCEPTION 'Unexpected private-schema access for role %', v_role;
    END IF;
    v_acl_checks := v_acl_checks + 1;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.community_dashboard()',
    'public.community_update_profile(text)',
    'public.community_check_in(integer,text,text,boolean)',
    'public.community_set_checkin_public(date,boolean)'
  ]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_signature);
    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc WHERE oid = v_function
        AND prosecdef AND 'search_path=""' = ANY(proconfig)
    ) THEN
      RAISE EXCEPTION 'Missing or unsafe definer function configuration: %', v_signature;
    END IF;
    IF NOT pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected RPC EXECUTE grants: %', v_signature;
    END IF;
    v_acl_checks := v_acl_checks + 1;
  END LOOP;

  FOR v_claims IN
    SELECT claim FROM (VALUES
      (jsonb_build_object('role', 'anon', 'sub', v_absent_sub, 'project_id', v_project, 'is_anonymous', true)),
      (jsonb_build_object('role', 'authenticated', 'project_id', v_project, 'is_anonymous', false)),
      (jsonb_build_object('role', 'authenticated', 'sub', '', 'project_id', v_project, 'is_anonymous', false)),
      (jsonb_build_object('role', 'authenticated', 'sub', v_absent_sub, 'project_id', v_project, 'is_anonymous', false))
    ) AS cases(claim)
  LOOP
    PERFORM pg_catalog.set_config('request.jwt.claims', v_claims::text, true);
    -- This environment's auth.uid()/auth.role() also support the legacy singular GUCs.
    -- Set both formats so a previous administrative request cannot affect the probe.
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_claims ->> 'sub', ''), true);
    PERFORM pg_catalog.set_config('request.jwt.claim.role', v_claims ->> 'role', true);

    IF auth.jwt() IS DISTINCT FROM v_claims
       OR auth.role() IS DISTINCT FROM (v_claims ->> 'role')
       OR nullif(auth.uid(), '') IS DISTINCT FROM nullif(v_claims ->> 'sub', '') THEN
      RAISE EXCEPTION 'Auth helper output does not match the transaction-local probe claims.';
    END IF;

    FOREACH v_command IN ARRAY ARRAY[
      'SELECT public.community_dashboard()',
      'SELECT public.community_update_profile(''权限核查'')',
      'SELECT public.community_check_in(1, '''', '''', false)',
      'SELECT public.community_set_checkin_public(''2000-01-01''::date, false)'
    ]
    LOOP
      BEGIN
        EXECUTE v_command;
        -- Never accept a successful call: force rollback of any unexpected mutation.
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Unauthorized RPC unexpectedly succeeded: ' || v_command;
      EXCEPTION
        WHEN SQLSTATE '42501' THEN
          v_rpc_checks := v_rpc_checks + 1;
      END;
    END LOOP;
  END LOOP;

  IF v_rpc_checks <> 16 OR v_acl_checks <> 13 OR v_rls_checks <> 2 THEN
    RAISE EXCEPTION 'Incomplete authorization probe.';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claims', coalesce(v_saved_claims, ''), true);
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_saved_sub, ''), true);
  PERFORM pg_catalog.set_config('request.jwt.claim.role', coalesce(v_saved_role, ''), true);
  RAISE NOTICE 'PASS: 16 unauthorized RPC calls rejected with 42501; 13 ACL checks passed; both tables have RLS; all 4 definers have empty search_path.';
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('request.jwt.claims', coalesce(v_saved_claims, ''), true);
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', coalesce(v_saved_sub, ''), true);
  PERFORM pg_catalog.set_config('request.jwt.claim.role', coalesce(v_saved_role, ''), true);
  RAISE;
END;
$paijian_guards$;
