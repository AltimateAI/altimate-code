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
  "safe_snapshot_blocking_pids|isolation_test_session_is_blocked|stat_(?!reset)\\w*|statio_\\w*|mcv_list_\\w*|" +
  "index\\w*_has_property|options_to_table|settings_get_flags|size_bytes|lsn\\w*|partition_\\w*|" +
  "table_is_visible|has_\\w*_privilege|database_collation_actual_version|" +
  "collation_actual_version|available_extension\\w*|control_\\w*|cursor\\w*|event_trigger_\\w*"

const PURE_PG_FUNCTION = new RegExp(`^pg_(?:${PURE_PG_FUNCTIONS})$`, "i")
// Explicit mutating families take precedence over broad inspection patterns
// (for example, a future pg_stat_reset_* name must not match the *_size getter).
const SIDE_EFFECT_PG_FUNCTION =
  /^pg_(?:write_file|append_file|file_write|file_rename|file_unlink|try_advisory\w*|advisory_unlock\w*|advisory_lock\w*|advisory_xact\w*|terminate_backend|cancel_backend|reload_conf|rotate_logfile|promote|switch_wal|logical_emit_message|create_\w*_replication_slot|drop_replication_slot|replication_slot_advance|replication_origin_\w+|notify|stat_reset\w*|wal_replay_\w+|logical_slot_\w+|replication_slot_\w+|xlog_replay_\w+|log_backend_memory_contexts|create_restore_point|backup_\w+|start_backup|stop_backup)$/i
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
