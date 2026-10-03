import { useMemo } from 'react'
import CodeMirror, { EditorView, Prec, keymap } from '@uiw/react-codemirror'
import { acceptCompletion } from '@codemirror/autocomplete'
import { python } from '@codemirror/lang-python'
import { sql, SQLDialect, MSSQL, MySQL, PLSQL, PostgreSQL } from '@codemirror/lang-sql'
import type { DatabaseType } from '../types'

export type CodeEditorLanguage = 'sql' | 'python'

// Vendor function names the bundled dialects don't ship. @codemirror/lang-sql's
// PL/SQL dialect only carries SQL*Plus *commands* (no TO_DATE, NVL, …), MySQL
// ships client commands rather than functions, and PostgreSQL has no dedicated
// built-in list, so each is topped up here. Space-separated, lowercase — the
// completer matches case-insensitively.
const ORACLE_FUNCTIONS =
  'to_date to_char to_number to_timestamp to_clob to_nclob to_blob to_dsinterval to_yminterval ' +
  'nvl nvl2 decode coalesce nullif greatest least nanvl ' +
  'sysdate systimestamp current_date current_timestamp localtimestamp ' +
  'add_months months_between last_day next_day extract trunc round ' +
  'instr substr substrb regexp_like regexp_instr regexp_replace regexp_substr regexp_count ' +
  'length lengthb replace translate initcap lpad rpad ltrim rtrim trim ' +
  'listagg wm_concat row_number rank dense_rank ntile lag lead first_value last_value ' +
  'stddev variance mod power sqrt sign abs ceil floor cast convert sys_guid sys_context'

const POSTGRES_FUNCTIONS =
  'to_char to_date to_timestamp to_number date_trunc date_part extract ' +
  'age justify_days justify_hours justify_interval make_date make_time make_timestamp make_interval ' +
  'string_agg array_agg unnest generate_series generate_subscripts array_length cardinality ' +
  'array_position jsonb_build_object jsonb_agg json_agg row_to_json to_json to_jsonb jsonb_path_query ' +
  'regexp_replace regexp_matches regexp_split_to_array regexp_split_to_table ' +
  'split_part concat_ws format repeat reverse strpos btrim chr ascii left right substring position overlay ' +
  'percentile_cont percentile_disc mode width_bucket'

const MYSQL_FUNCTIONS =
  'now curdate curtime sysdate utc_date utc_time utc_timestamp ' +
  'date_format str_to_date date_add date_sub datediff timediff timestampdiff ' +
  'date time year month day hour minute second ' +
  'ifnull nullif if coalesce greatest least ' +
  'concat concat_ws group_concat substring_index left right lpad rpad char_length length locate instr ' +
  'lower upper trim ltrim rtrim replace ' +
  'round floor ceil ceiling truncate mod pow power sqrt rand abs sign ' +
  'json_extract json_object json_array json_length cast convert last_insert_id uuid'

/** A dialect is immutable, so extending one means re-defining it with the extra
 *  built-ins appended to whatever the base dialect already ships. */
function withBuiltins(base: SQLDialect, builtins: string): SQLDialect {
  return SQLDialect.define({
    ...base.spec,
    builtin: `${base.spec.builtin ?? ''} ${builtins}`.trim(),
  })
}

/** SQL completion dialect for the active server type. Unknown / 'auto' (and
 *  anything without a bundled vendor dialect) falls back to plain `sql()`. */
function sqlLanguage(dbType: DatabaseType | undefined) {
  switch (dbType) {
    case 'sqlserver':
      return sql({ dialect: MSSQL })
    case 'oracle':
      return sql({ dialect: withBuiltins(PLSQL, ORACLE_FUNCTIONS) })
    case 'postgresql':
      return sql({ dialect: withBuiltins(PostgreSQL, POSTGRES_FUNCTIONS) })
    case 'mysql':
      return sql({ dialect: withBuiltins(MySQL, MYSQL_FUNCTIONS) })
    default:
      return sql()
  }
}

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language: CodeEditorLanguage
  /** Server type of the active connection — selects the vendor function /
   *  keyword list for SQL completion. Omit (or 'auto') for standard SQL. */
  sqlDialect?: DatabaseType
  placeholder?: string
  /** Accessibility label forwarded to the editor container. */
  ariaLabel?: string
  minHeight?: string
  maxHeight?: string
}

/** Code editor used for SQL queries and Python scripts (CodeMirror 6, bundled). */
export default function CodeEditor({
  value,
  onChange,
  language,
  sqlDialect,
  placeholder,
  ariaLabel,
  minHeight = '170px',
  maxHeight = '400px',
}: CodeEditorProps) {
  const extensions = useMemo(
    () => [
      language === 'sql' ? sqlLanguage(sqlDialect) : python(),
      EditorView.lineWrapping,
      // Enter/Tab accept the highlighted completion. Enter is already bound by
      // CodeMirror's default completion keymap, but Tab is not — bind both
      // explicitly at highest precedence so they can never be shadowed. Both
      // return false when no popup is open, so Enter still makes newlines.
      Prec.highest(
        keymap.of([
          { key: 'Enter', run: acceptCompletion },
          { key: 'Tab', run: acceptCompletion },
        ]),
      ),
    ],
    [language, sqlDialect],
  )

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      aria-label={ariaLabel}
      minHeight={minHeight}
      maxHeight={maxHeight}
      style={{ fontFamily: 'Consolas, monospace', fontSize: '0.9rem' }}
    />
  )
}
