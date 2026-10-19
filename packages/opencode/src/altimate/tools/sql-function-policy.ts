// PostgreSQL administrative, WAL, replication, statistics-reset, large-object,
// file and dblink calls can change state outside a read-only transaction. Unknown
// pg_* functions stay denied; allow known inspection functions by their full name.
const PURE_PG_FUNCTIONS =
  "typeof|size_pretty|column_size|\\w*_size|backend_pid|is_in_recovery|get_\\w*|describe_object|identify_object\\w*|" +
  "input_is_valid|input_error_info|trigger_depth|has_role|\\w*_is_visible|current_\\w*_lsn|last_\\w*_lsn|" +
  "last_xact_replay_timestamp|is_wal_replay_paused|wal_lsn_diff|walfile_name\\w*|" +
  "split_walfile_name|postmaster_start_time|conf_load_time|my_temp_schema|is_other_temp_schema|jit_available|" +
  "collation_for|tablespace_\\w*|relation_filepath|relation_filenode|filenode_relation|char_to_encoding|" +
  "encoding_to_char|client_encoding|column_compression|xact_commit_timestamp\\w*|current_xact_id\\w*|current_snapshot|" +
  "snapshot_\\w*|visible_in_snapshot|notification_queue_usage|listening_channels|blocking_pids|" +
  "safe_snapshot_blocking_pids|isolation_test_session_is_blocked|stat_(?!\\w*(?:reset|clear|force))\\w*|statio_\\w*|mcv_list_\\w*|" +
  "index\\w*_has_property|options_to_table|settings_get_flags|size_bytes|lsn\\w*|partition_\\w*|" +
  "table_is_visible|has_\\w*_privilege|database_collation_actual_version|" +
  "collation_actual_version|available_extension\\w*|control_\\w*|cursor\\w*|event_trigger_\\w*"

const PURE_PG_FUNCTION = new RegExp(`^pg_(?:${PURE_PG_FUNCTIONS})$`, "i")
// Explicit mutating families take precedence over broad inspection patterns
// (for example, a future pg_stat_reset_* name must not match the *_size getter).
const SIDE_EFFECT_PG_FUNCTION =
  /^pg_(?:write_file|append_file|file_write|file_rename|file_unlink|try_advisory\w*|advisory_unlock\w*|advisory_lock\w*|advisory_xact\w*|terminate_backend|cancel_backend|reload_conf|rotate_logfile|promote|switch_wal|logical_emit_message|create_\w*_replication_slot|drop_replication_slot|replication_slot_advance|replication_origin_\w+|notify|stat\w*reset\w*|\w*_reset\w*|stat_clear\w*|stat_force\w*|wal_replay_\w+|logical_slot_\w+|replication_slot_\w+|xlog_replay_\w+|log_backend_memory_contexts|create_restore_point|backup_\w+|start_backup|stop_backup)$/i
const SIDE_EFFECT_FUNCTION =
  /^(?:nextval|setval|set_config|load_extension|writefile|dblink\w*|lo_\w*|lowrite|loread|checkpoint|force_checkpoint|get_lock|release_lock|release_all_locks|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sleep|benchmark|postgres_execute|mysql_execute|sqlite_execute|SYSTEM\$\w+)$/i

/** Accepts one decoded function identifier, without schema names or SQL text. */
export function hasSideEffectFunction(name: string, rejectUnknownPg = true): boolean {
  return (
    SIDE_EFFECT_FUNCTION.test(name) ||
    SIDE_EFFECT_PG_FUNCTION.test(name) ||
    (rejectUnknownPg && /^pg_/i.test(name) && !PURE_PG_FUNCTION.test(name))
  )
}

// Nested and remote SQL runs without the outer driver's read-only boundary, so
// the denylist above cannot prove it safe: any user-defined function may write.
// Such SQL is a read only when every call it makes is on this explicit allowlist
// (standard SQL keywords that precede "(", types, aggregates, window, scalar,
// string, math, date, JSON, array and catalog functions). Everything else,
// including every schema-qualified or unknown function, requires write permission.
const WORDS = (list: string) => list.split(/\s+/).filter(Boolean)
const READ_ONLY_NESTED_FUNCTIONS = new Set(
  WORDS(`
  select from where join on using in not exists any all some as over partition values with and or between case
  when then else end like ilike similar is null distinct limit offset fetch filter within lateral rows range row
  array interval table union intersect except by having group order cast try_cast extract
  varchar char character text integer int bigint smallint tinyint numeric decimal float double real timestamp time
  date datetime bit boolean binary varbinary
  count sum avg min max total stddev stddev_pop stddev_samp variance var_pop var_samp string_agg array_agg
  group_concat listagg json_agg jsonb_agg json_object_agg jsonb_object_agg bool_and bool_or every bit_and bit_or
  median mode percentile_cont percentile_disc corr covar_pop covar_samp approx_count_distinct arg_min arg_max
  any_value first last list json_group_array json_group_object
  row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
  coalesce nullif greatest least ifnull nvl iif if isnull typeof convert
  abs ceil ceiling floor round trunc truncate sqrt cbrt power pow exp ln log log10 log2 mod sign sin cos tan asin
  acos atan atan2 pi degrees radians random div gcd lcm width_bucket bit_count
  length char_length character_length octet_length bit_length lower upper initcap trim ltrim rtrim btrim substr
  substring left right lpad rpad replace translate concat concat_ws position strpos instr locate reverse repeat
  split_part regexp_replace regexp_matches regexp_match regexp_substr regexp_like regexp_extract
  regexp_split_to_array regexp_split_to_table string_to_array array_to_string starts_with ends_with contains md5
  sha1 sha256 ascii chr format to_char to_number to_date to_timestamp overlay hex unhex to_hex encode decode
  quote_ident quote_literal quote_nullable
  now current_date current_time current_timestamp localtime localtimestamp date_trunc date_part age date_add
  date_sub dateadd datediff date_diff timestampdiff adddate subdate year month day hour minute second week quarter
  dayofweek dayofmonth dayofyear dayname monthname weekday last_day make_date make_timestamp make_time
  make_interval strftime strptime julianday unixepoch from_unixtime unix_timestamp epoch epoch_ms date_format
  str_to_date curdate curtime
  json_extract json_extract_string json_array_length json_array json_object json_build_object json_build_array
  jsonb_build_object jsonb_build_array json_typeof jsonb_typeof json_valid json_type json_value
  jsonb_array_elements jsonb_array_elements_text json_array_elements json_each jsonb_each jsonb_each_text
  json_object_keys jsonb_object_keys jsonb_extract_path jsonb_extract_path_text json_extract_path_text to_json
  to_jsonb row_to_json
  array_length cardinality array_upper array_lower array_position array_contains list_contains len unnest
  generate_series
  current_database current_schema current_schemas current_user session_user current_catalog current_setting
  version database schema user connection_id found_rows row_count sqlite_version sqlite_source_id
  obj_description col_description shobj_description format_type to_regclass to_regtype to_regproc to_regnamespace
  to_regrole has_any_column_privilege
`),
)
const READ_ONLY_CATALOG_SCHEMAS = new Set(["pg_catalog", "information_schema"])

/** True when a nested or remote call is provably read-only. Fail closed for anything unlisted. */
export function isReadOnlyNestedFunction(name: string, qualifier?: string): boolean {
  if (hasSideEffectFunction(name)) return false
  if (qualifier !== undefined && !READ_ONLY_CATALOG_SCHEMAS.has(qualifier)) return false
  return READ_ONLY_NESTED_FUNCTIONS.has(name) || PURE_PG_FUNCTION.test(name) || /^has_\w+_privilege$/.test(name)
}
