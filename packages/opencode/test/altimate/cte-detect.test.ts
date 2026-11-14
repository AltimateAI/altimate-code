import { describe, expect, it } from "bun:test"
import {
  buildCountQuery,
  detectCtes as detectCtesInText,
  extractRowCount,
  quoteSqlIdentifier,
  stripColumnList,
  unclosedJinjaBlock,
  type CteInfo,
} from "../../src/altimate/tools/cte-detect"

// Detector cases ported from the dbt Power User CTE detector suite. A "document" is the model text.
describe("detectCtes", () => {
  const detectCtes = (document: string): CteInfo[] => detectCtesInText(document)

  const assertCTE = (cte: CteInfo, expectedName: string, expectedIndex: number, _description?: string) => {
    expect(cte.name).toBe(expectedName)
    expect(cte.index).toBe(expectedIndex)
    expect(typeof cte.nameStart).toBe("number")
    expect(typeof cte.queryStart).toBe("number")
    expect(typeof cte.withClauseStart).toBe("number")
  }

  describe("Basic CTE Detection", () => {
    it("should detect single CTE correctly with proper ranges", () => {
      const sql = "with my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with simple select and ID column")
    })

    it("should detect multiple CTEs correctly with proper indexing", () => {
      const sql = `with
        first_cte as (select 1 as id),
        second_cte as (select 2 as id),
        third_cte as (select 3 as id)
      select * from third_cte`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(3)
      assertCTE(ctes[0], "first_cte", 0, "CTE with simple select")
      assertCTE(ctes[1], "second_cte", 1, "CTE with different ID value")
      assertCTE(ctes[2], "third_cte", 2, "CTE with third ID value")
    })

    it("should handle CTEs with column lists", () => {
      const sql = "with my_cte (id, name) as (select 1, 'test') select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte (id, name)", 0, "CTE with explicit column list specification")
    })

    it("should handle quoted CTE names", () => {
      const sql = `with "my cte" as (select 1 as id) select * from "my cte"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], '"my cte"', 0, "CTE with double-quoted name containing space")
    })
  })

  describe("Comments in CTE Body", () => {
    it("should handle line comments with unmatched quotes in CTE body", () => {
      const sql = `with
        cte_without_lens as (
          select *
          from {{ ref('parent') }}
          where
            condition = true  -- CTE doesn't have a lens
        ),
        cte_with_lens as (
          select *
          from {{ ref('parent') }}
          where
            condition = true -- CTE has a 'lens'
        )
      select * from cte_with_lens`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(2)
      assertCTE(ctes[0], "cte_without_lens", 0, "CTE with line comment containing unmatched single quote")
      assertCTE(ctes[1], "cte_with_lens", 1, "CTE with line comment containing matched single quotes")
    })

    it("should handle block comments with unmatched quotes in CTE body", () => {
      const sql = `with
        cte_with_block_comment as (
          select *
          from {{ ref('parent') }}
          where
            condition = true /* This is a block comment with unmatched quote ' */
        )
      select * from cte_with_block_comment`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "cte_with_block_comment", 0, "CTE with block comment containing unmatched single quote")
    })

    it("should handle Jinja comments with unmatched quotes in CTE body", () => {
      const sql = `with
        cte_with_jinja_comment as (
          select *
          from {{ ref('parent') }}
          where
            condition = true {# This is a Jinja comment with unmatched quote ' #}
        )
      select * from cte_with_jinja_comment`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "cte_with_jinja_comment", 0, "CTE with Jinja comment containing unmatched single quote")
    })
  })

  describe("Comments Between CTE Name and AS", () => {
    it("should handle single-line block comment between name and AS", () => {
      const sql = "with source /* test */ as (select 1 as id) select * from source"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "source", 0, "CTE with single-line block comment between name and AS keyword")
      // The important part is that CTE detection works correctly
    })

    it("should handle multi-line block comment between name and AS", () => {
      const sql = `with source 
/* this is 
a multi-line comment
that should be ignored */
as (
  select * from {{ ref('raw_orders') }}
)
select * from source`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "source", 0, "CTE with multi-line block comment between name and AS keyword")
      // The important part is that CTE detection works correctly
    })

    it("should handle Jinja comment between name and AS", () => {
      const sql = "with target {# some comment #} as (select 1 as id) select * from target"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "target", 0, "CTE with Jinja comment between name and AS keyword")
    })

    it("should handle line comment between name and AS (multiline)", () => {
      const sql = `with multiline_cte -- this is a comment
      as (
        select 4 as id
      )
      select * from multiline_cte`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "multiline_cte", 0, "CTE with line comment on separate line before AS keyword")
    })

    it("should handle complex comment with quotes between name and AS", () => {
      const sql = `with complex_comment /* more complex comment with 'quotes' */ as (
        select 5 as id
      ) select * from complex_comment`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "complex_comment", 0, "CTE with block comment containing both single and double quotes")
    })
  })

  describe("Comments Before and Around CTE Names", () => {
    it("should handle block comment before CTE name", () => {
      const sql = "with /* comment before name */ my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with block comment before name")
    })

    it("should handle line comment before CTE name on separate line", () => {
      const sql = `with
        -- This is a comment before the CTE name
        my_cte as (
          select 1 as id
        )
      select * from my_cte`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with line comment before name on separate line")
    })

    it("should handle Jinja comment before CTE name", () => {
      const sql = "with {# comment before name #} my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with Jinja comment before name")
    })

    it("should handle comment immediately after WITH keyword", () => {
      const sql = "with /* comment after WITH */ my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with block comment immediately after WITH keyword")
    })

    it("should handle line comment after WITH keyword", () => {
      const sql = `with -- comment after WITH
        my_cte as (
          select 1 as id
        )
      select * from my_cte`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with line comment after WITH keyword")
    })

    it("should handle multiple comments around CTE name", () => {
      const sql = "with /* before */ my_cte /* after */ as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with block comments before and after name")
    })

    it("should handle mixed comment types around CTE name", () => {
      const sql = `with -- line comment
        /* block comment */ my_cte {# jinja comment #} as (
          select 1 as id
        )
      select * from my_cte`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with mixed comment types around name")
    })

    it("should handle comments in multi-CTE scenarios", () => {
      const sql = `with
        /* comment */ first_cte as (
          select 1 as id
        ),
        -- another comment
        second_cte /* inline comment */ as (
          select 2 as id
        ),
        {# jinja comment #} third_cte as (
          select 3 as id
        )
      select * from third_cte`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(3)
      assertCTE(ctes[0], "first_cte", 0, "First CTE with block comment before name")
      assertCTE(ctes[1], "second_cte", 1, "Second CTE with line and inline comments")
      assertCTE(ctes[2], "third_cte", 2, "Third CTE with Jinja comment before name")
    })

    it("should handle comments with special characters around CTE name", () => {
      const sql = "with /* comment with $pecial ch@rs & symbols! */ my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with comment containing special characters")
    })

    it("should handle unterminated block comment before CTE name", () => {
      const sql = "with /* unterminated comment my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      // The comment swallows the rest of the text, so there is no CTE to find.
      expect(ctes).toEqual([])
    })

    it("should handle sequential line and block comments between name and AS", () => {
      const sql = `with source -- test
/* this is
a multi-line comment
that should be ignored */
as (
    select * from {{ ref('raw_orders') }}
)
select * from renamed`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "source", 0, "CTE with sequential line and block comments between name and AS")
    })
  })

  describe("Complex Comment Scenarios", () => {
    it("should handle CTE with mixed block and Jinja comments", () => {
      const sql = `with
source /* test */ as(
    {#-
    Normally we would select from the table here, but we are using seeds to load
    our data in this project
    #}
    select * from {{ ref('raw_orders') }}
),

renamed as (
    select
        id as order_id,
        user_id as customer_id,
        order_date,
        status
    from source
)

select * from renamed`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(2)
      assertCTE(ctes[0], "source", 0, "CTE with block comment after name and Jinja comment in body")
      assertCTE(ctes[1], "renamed", 1, "CTE that references another CTE with column aliasing")
    })

    it("should handle CTE with multi-line block comment before AS keyword", () => {
      const sql = `with source 
/* this is 
a multi-line comment
that should be ignored */
as (
    select * from {{ ref('raw_orders') }}
),

renamed as (
    select
        id as order_id,
        user_id as customer_id,
        order_date,
        status
    from source
)

select * from renamed`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(2)
      assertCTE(ctes[0], "source", 0, "CTE with multi-line block comment spanning multiple lines before AS")
      assertCTE(ctes[1], "renamed", 1, "CTE that selects from another CTE with column renaming")
    })
  })

  describe("Very Lengthy Comments with Quoted Names", () => {
    it("should handle extremely long block comment before quoted CTE name", () => {
      // Create a 1500+ character comment to test real-world lengthy comment scenarios
      const longComment =
        "/* " +
        "This is an extremely long comment that might appear in real-world SQL files. ".repeat(25) +
        "It contains multiple sentences and potentially problematic content like 'quoted strings', " +
        "special characters !@#$%^&*()_+-=[]{}|;:,.<>?, and even problematic keywords " +
        "that might confuse the parser. This comment also contains backslashes \\ and forward slashes // " +
        "and other regex-problematic characters like .*+?^${}()|[] that could cause catastrophic backtracking " +
        "in poorly designed regular expressions. The comment goes on and on longer. ".repeat(10) +
        " */"

      const sql = `with ${longComment} "quoted_cte_name" as (select 1 as id) select * from "quoted_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"quoted_cte_name"',
        0,
        "CTE with extremely long block comment (1500+ chars) before quoted name",
      )
    })

    it("should handle extremely long line comment before quoted CTE name", () => {
      // Create a 1000+ character line comment
      const longLineComment =
        "-- " +
        "This is an extremely long line comment that might appear in real-world SQL files. ".repeat(12) +
        "It contains 'quoted strings' and special characters that could cause issues. "

      const sql = `with\n${longLineComment}\n"quoted_cte_name" as (select 1 as id) select * from "quoted_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"quoted_cte_name"',
        0,
        "CTE with extremely long line comment (1000+ chars) before quoted name",
      )
    })

    it("should handle extremely long Jinja comment before quoted CTE name", () => {
      // Create a 1200+ character Jinja comment
      const longJinjaComment =
        "{# " +
        "This is an extremely long Jinja comment that might appear in real-world dbt files. ".repeat(15) +
        "It contains 'quoted strings', template variables like {{ var('my_var') }}, and complex logic. " +
        "The comment includes special characters and database keywords that could confuse parsers. " +
        " #}"

      const sql = `with ${longJinjaComment} "quoted_cte_name" as (select 1 as id) select * from "quoted_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"quoted_cte_name"',
        0,
        "CTE with extremely long Jinja comment (1200+ chars) before quoted name",
      )
    })

    it("should handle extremely long block comment after quoted CTE name", () => {
      // Create a 2000+ character comment after the name
      const longComment =
        "/* " +
        "This is an extremely long comment that appears after the table name but before AS. ".repeat(30) +
        "It contains multiple paragraphs, 'quoted strings', and complex descriptions that might " +
        "explain the business logic behind the transformation. The comment includes database keywords, special " +
        "characters, and other potentially problematic content for regex parsing. ".repeat(5) +
        " */"

      const sql = `with "quoted_cte_name" ${longComment} as (select 1 as id) select * from "quoted_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"quoted_cte_name"',
        0,
        "CTE with extremely long block comment (2000+ chars) after quoted name",
      )
    })

    it("should handle multiple very long comments around quoted CTE name", () => {
      // Create multiple long comments around the CTE name
      const longCommentBefore =
        "/* " + "Long comment before the CTE name. ".repeat(20) + "Contains 'quotes' and special characters. " + " */"

      const longCommentAfter =
        "/* " +
        "Long comment after the CTE name but before AS. ".repeat(20) +
        "Also contains 'quotes' and special characters. " +
        " */"

      const sql = `with ${longCommentBefore} "quoted_cte_name" ${longCommentAfter} as (select 1 as id) select * from "quoted_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], '"quoted_cte_name"', 0, "CTE with multiple very long comments around quoted name")
    })

    it("should handle extremely long mixed comment types around quoted CTE name", () => {
      // Test with line comment, block comment, and Jinja comment (avoid SQL keywords in comments)
      const longLineComment = "-- " + "Very long line comment containing 'quotes' and special characters. ".repeat(10)

      const longBlockComment =
        "/* " + "Very long block comment containing 'quotes' and special characters. ".repeat(15) + " */"

      const longJinjaComment =
        "{# " + "Very long Jinja comment containing 'quotes' and template logic. ".repeat(10) + " #}"

      const sql = `${longLineComment}\n${longBlockComment}\nwith "quoted_cte_name" ${longJinjaComment} as (select 1 as id) select * from "quoted_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], '"quoted_cte_name"', 0, "CTE with extremely long mixed comment types around quoted name")
    })

    it("should handle lengthy comments with quoted names in multi-CTE scenario", () => {
      // Test performance with multiple CTEs each having lengthy comments
      const longComment1 =
        "/* " +
        "First data source containing very long description. ".repeat(25) +
        "Contains 'quotes' and special characters for testing. " +
        " */"

      const longComment2 =
        "/* " +
        "Second data source containing very long description. ".repeat(25) +
        "Also contains 'quotes' and special characters for testing. " +
        " */"

      const sql = `with
        ${longComment1} "first_quoted_cte" as (
          select 1 as id, 'first' as name
        ),
        ${longComment2} "second_quoted_cte" as (
          select 2 as id, 'second' as name
        )
      select * from "first_quoted_cte" union all select * from "second_quoted_cte"`

      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(2)
      assertCTE(ctes[0], '"first_quoted_cte"', 0, "First CTE with very long comment before quoted name")
      assertCTE(ctes[1], '"second_quoted_cte"', 1, "Second CTE with very long comment before quoted name")
    })

    it("should handle extremely long comments with regex-problematic content", () => {
      // Create a comment with content that could cause regex issues
      const problemComment =
        "/* " +
        "This comment contains regex-problematic content: .*+?^${}()|[] ".repeat(20) +
        "It also has nested quotes like 'text with \"nested quotes\" inside' and " +
        "backslashes \\ and forward slashes // that could break poorly designed regex. " +
        "The comment includes SQL injection attempts like '; DROP TABLE users; -- " +
        "and other malicious content that should be handled safely. ".repeat(10) +
        " */"

      const sql = `with ${problemComment} "secure_cte_name" as (select 1 as id) select * from "secure_cte_name"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], '"secure_cte_name"', 0, "CTE with extremely long comment containing regex-problematic content")
    })
  })

  describe("MAX_QUOTED_IDENTIFIER_LENGTH Edge Cases", () => {
    it("should handle comments with quoted strings longer than MAX_QUOTED_IDENTIFIER_LENGTH", () => {
      // Create a quoted string in comment that's longer than 500 chars
      const veryLongQuotedString = '"' + "a".repeat(600) + '"'
      const commentWithLongQuotedString = `/* This comment contains a very long quoted string: ${veryLongQuotedString} that exceeds the MAX_QUOTED_IDENTIFIER_LENGTH limit */`

      const sql = `with ${commentWithLongQuotedString} "real_cte" as (select 1 as id) select * from "real_cte"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"real_cte"',
        0,
        "CTE with comment containing quoted string longer than MAX_QUOTED_IDENTIFIER_LENGTH",
      )
    })

    it("should handle quoted CTE name approaching MAX_QUOTED_IDENTIFIER_LENGTH limit", () => {
      // Create a quoted CTE name that's close to but under the 500 char limit
      const longCTEName = '"' + "very_long_cte_name_" + "x".repeat(450) + '"'

      const sql = `with ${longCTEName} as (select 1 as id) select * from ${longCTEName}`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], longCTEName, 0, "CTE with quoted name approaching MAX_QUOTED_IDENTIFIER_LENGTH limit")
    })

    it("should handle quoted CTE name exactly at MAX_QUOTED_IDENTIFIER_LENGTH limit", () => {
      // Create a quoted CTE name that's exactly at the 500 char limit (498 chars inside quotes + 2 quotes = 500)
      const exactLimitCTEName = '"' + "x".repeat(498) + '"'

      const sql = `with ${exactLimitCTEName} as (select 1 as id) select * from ${exactLimitCTEName}`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], exactLimitCTEName, 0, "CTE with quoted name exactly at MAX_QUOTED_IDENTIFIER_LENGTH limit")
    })

    it("should handle comment with multiple long quoted strings and real CTE", () => {
      // Test multiple long quoted strings in comments
      const longQuotedString1 = '"' + "fake_identifier_1_" + "a".repeat(600) + '"'
      const longQuotedString2 = '"' + "fake_identifier_2_" + "b".repeat(700) + '"'
      const commentWithMultipleLongQuotes = `/* Comment with ${longQuotedString1} and also ${longQuotedString2} */`

      const sql = `with ${commentWithMultipleLongQuotes} "actual_cte" as (select 1 as id) select * from "actual_cte"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"actual_cte"',
        0,
        "CTE with comment containing multiple quoted strings longer than MAX_QUOTED_IDENTIFIER_LENGTH",
      )
    })

    it("should handle extremely long comment with quoted content and real long CTE name", () => {
      // Combine very long comment with quoted content AND a long CTE name
      const longQuotedInComment = '"' + "fake_cte_name_in_comment_" + "z".repeat(800) + '"'
      const longComment = `/* ${"Very long comment text. ".repeat(50)} Contains fake quoted identifier: ${longQuotedInComment} ${"More comment text. ".repeat(30)} */`
      const longRealCTEName = '"' + "real_cte_name_" + "r".repeat(400) + '"'

      const sql = `with ${longComment} ${longRealCTEName} as (select 1 as id) select * from ${longRealCTEName}`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        longRealCTEName,
        0,
        "CTE with extremely long comment containing long quoted string and long real CTE name",
      )
    })

    it("should handle line comment with long quoted string before quoted CTE", () => {
      // Test line comment with long quoted content
      const longQuotedInLineComment = '"' + "fake_line_comment_identifier_" + "l".repeat(600) + '"'
      const lineComment = `-- Line comment with long quoted string: ${longQuotedInLineComment}`

      const sql = `with\n${lineComment}\n"real_cte" as (select 1 as id) select * from "real_cte"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"real_cte"',
        0,
        "CTE with line comment containing quoted string longer than MAX_QUOTED_IDENTIFIER_LENGTH",
      )
    })

    it("should handle Jinja comment with long quoted string before quoted CTE", () => {
      // Test Jinja comment with long quoted content
      const longQuotedInJinjaComment = '"' + "fake_jinja_identifier_" + "j".repeat(650) + '"'
      const jinjaComment = `{# Jinja comment with long quoted string: ${longQuotedInJinjaComment} #}`

      const sql = `with ${jinjaComment} "real_cte" as (select 1 as id) select * from "real_cte"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(
        ctes[0],
        '"real_cte"',
        0,
        "CTE with Jinja comment containing quoted string longer than MAX_QUOTED_IDENTIFIER_LENGTH",
      )
    })

    it("should handle mixed comment types with various length quoted strings", () => {
      // Test combination of different comment types with various length quoted strings
      const shortQuoted = '"short"'
      const mediumQuoted = '"' + "medium_" + "m".repeat(200) + '"'
      const longQuoted = '"' + "very_long_" + "v".repeat(800) + '"'

      const lineComment = `-- Line comment with ${shortQuoted}`
      const blockComment = `/* Block comment with ${mediumQuoted} and ${longQuoted} */`
      const jinjaComment = `{# Jinja comment with ${longQuoted} #}`

      const sql = `${lineComment}\n${blockComment}\nwith ${jinjaComment} "mixed_test_cte" as (select 1 as id) select * from "mixed_test_cte"`
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], '"mixed_test_cte"', 0, "CTE with mixed comment types containing various length quoted strings")
    })
  })

  describe("CTE Column List Test Cases", () => {
    describe("Basic Column List Variations", () => {
      it("should handle simple column list with multiple columns", () => {
        const sql =
          "with my_cte (id, name, email, created_at) as (select 1, 'John', 'john@example.com', now()) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte (id, name, email, created_at)", 0, "CTE with multiple column names in list")
      })

      it("should handle column list with quoted column names", () => {
        const sql =
          'with my_cte ("user id", "full name", "email address") as (select 1, \'John Doe\', \'john@example.com\') select * from my_cte'
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          'my_cte ("user id", "full name", "email address")',
          0,
          "CTE with quoted column names containing spaces",
        )
      })

      it("should handle column list with mixed quoted and unquoted names", () => {
        const sql =
          "with my_cte (id, \"user name\", email, \"created at\") as (select 1, 'John', 'john@example.com', now()) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          'my_cte (id, "user name", email, "created at")',
          0,
          "CTE with mixed quoted and unquoted column names",
        )
      })

      it("should handle column list with simple data types", () => {
        const sql =
          "with my_cte (id integer, name varchar, amount decimal) as (select 1, 'John', 100.50) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          "my_cte (id integer, name varchar, amount decimal)",
          0,
          "CTE with simple column names and data types",
        )
      })

      it("should handle column list with single column", () => {
        const sql = "with my_cte (single_column) as (select 'value') select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte (single_column)", 0, "CTE with single column in list")
      })
    })

    describe("Length and Performance Edge Cases", () => {
      it("should handle column list approaching MAX_COLUMN_LIST_LENGTH limit", () => {
        // Create a column list that's close to but under the 1000 char limit
        const longColumnList = Array.from({ length: 20 }, (_, i) => `column_${i}_with_long_name`).join(", ")
        const sql = `with my_cte (${longColumnList}) as (select ${Array.from({ length: 20 }, (_, i) => i).join(", ")}) select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          `my_cte (${longColumnList})`,
          0,
          "CTE with column list approaching MAX_COLUMN_LIST_LENGTH limit",
        )
      })

      it("should handle column list near MAX_COLUMN_LIST_LENGTH limit", () => {
        // Create a column list that's close to the 1000 char limit
        const nearLimitColumnList = "x".repeat(900) // 900 chars - well within limit
        const sql = `with my_cte (${nearLimitColumnList}) as (select 1) select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          `my_cte (${nearLimitColumnList})`,
          0,
          "CTE with column list near MAX_COLUMN_LIST_LENGTH limit",
        )
      })

      it("should handle very long individual column names", () => {
        const longColumnName1 = '"' + "very_long_column_name_" + "a".repeat(200) + '"'
        const longColumnName2 = '"' + "another_long_column_name_" + "b".repeat(200) + '"'
        const sql = `with my_cte (${longColumnName1}, ${longColumnName2}) as (select 1, 2) select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          `my_cte (${longColumnName1}, ${longColumnName2})`,
          0,
          "CTE with very long individual column names",
        )
      })
    })

    describe("Complex Column List Scenarios", () => {
      it("should handle column list with nested parentheses (function calls)", () => {
        const sql =
          "with my_cte (id, calculated_value, formatted_date) as (select 1, round(avg(amount), 2), to_char(created_at, 'YYYY-MM-DD')) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          "my_cte (id, calculated_value, formatted_date)",
          0,
          "CTE with column list containing nested parentheses from function calls",
        )
      })

      it("should handle column list with simple constraints", () => {
        const sql =
          "with my_cte (id not null, name, amount default 0) as (select 1, 'John', 100.0) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          "my_cte (id not null, name, amount default 0)",
          0,
          "CTE with column list containing simple constraints",
        )
      })

      it("should handle column list with line breaks and formatting", () => {
        const sql = `with my_cte (
          id,
          name,
          email,
          created_at
        ) as (
          select 1, 'John', 'john@example.com', now()
        ) select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          `my_cte (
          id,
          name,
          email,
          created_at
        )`,
          0,
          "CTE with multi-line formatted column list",
        )
      })

      it("should handle column list with special characters and escaped quotes", () => {
        const sql = `with my_cte ("col_with_'quote", "col with spaces", "col@with#symbols") as (select 1, 2, 3) select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          `my_cte ("col_with_'quote", "col with spaces", "col@with#symbols")`,
          0,
          "CTE with column list containing special characters and quotes",
        )
      })
    })

    describe("Column List + Comment Combinations", () => {
      it("should handle comments before the opening parenthesis", () => {
        const sql = "with my_cte /* comment before column list */ (id, name) as (select 1, 'John') select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte (id, name)", 0)
      })

      it("should handle comments after the closing parenthesis", () => {
        const sql = "with my_cte (id, name) /* comment after column list */ as (select 1, 'John') select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte (id, name)", 0, "CTE with comment after column list closing parenthesis")
      })

      it("should handle comments between column list and AS keyword", () => {
        const sql = `with my_cte (id, name, email)
        -- This is a comment before AS
        /* Another comment */
        as (select 1, 'John', 'john@example.com') select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte (id, name, email)", 0, "CTE with comments between column list and AS keyword")
      })

      it("should handle mixed comment types around column lists", () => {
        const sql = `with /* before */ my_cte (
          id, -- line comment
          name /* inline comment */,
          email
        ) {# jinja comment #} as (select 1, 'John', 'john@example.com') select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        // Comments within column lists are currently included in the CTE name
        // This is expected behavior given the current parsing approach
        assertCTE(
          ctes[0],
          `my_cte (
          id, -- line comment
          name /* inline comment */,
          email
        )`,
          0,
          "CTE with mixed comment types around column list",
        )
      })
    })

    describe("Error Handling and Edge Cases", () => {
      it("should handle empty column lists", () => {
        const sql = "with my_cte () as (select 1) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte ()", 0, "CTE with empty column list")
      })

      it("should handle column lists with only whitespace", () => {
        const sql = "with my_cte (   ) as (select 1) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(ctes[0], "my_cte (   )", 0, "CTE with whitespace-only column list")
      })

      it("should handle column lists in combination with quoted CTE names", () => {
        const sql =
          'with "my cte" (id, "user name", email) as (select 1, \'John\', \'john@example.com\') select * from "my cte"'
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          '"my cte" (id, "user name", email)',
          0,
          "CTE with quoted name and column list with quoted columns",
        )
      })

      it("should handle deeply nested parentheses in column definitions", () => {
        const sql =
          "with my_cte (calculated_field, nested_calc) as (select sum(case when (x > 0 and (y < 10 or z = (a + b))) then 1 else 0 end), avg(coalesce(field1, field2, 0))) select * from my_cte"
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          "my_cte (calculated_field, nested_calc)",
          0,
          "CTE with column list and deeply nested parentheses in query",
        )
      })
    })

    describe("Real-World Complex Scenarios", () => {
      it("should handle simple BigQuery-style column definitions", () => {
        const sql = `with my_cte (
          user_id INT64,
          user_name STRING,
          created_at TIMESTAMP
        ) as (
          select 1, 'John', current_timestamp()
        ) select * from my_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(1)
        assertCTE(
          ctes[0],
          `my_cte (
          user_id INT64,
          user_name STRING,
          created_at TIMESTAMP
        )`,
          0,
          "CTE with simple BigQuery-style column definitions",
        )
      })

      it("should handle multi-CTE scenarios with varying column list complexity", () => {
        const sql = `with
          simple_cte (id, name) as (
            select 1, 'John'
          ),
          complex_cte (
            user_id,
            "full name",
            calculated_field,
            metadata_json
          ) as (
            select id, name, id * 100, '{"key": "value"}'
            from simple_cte
          ),
          no_columns_cte as (
            select * from complex_cte
          )
        select * from no_columns_cte`
        const document = sql

        const ctes = detectCtes(document)

        expect(ctes).toHaveLength(3)
        assertCTE(ctes[0], "simple_cte (id, name)", 0, "First CTE with simple column list")
        assertCTE(
          ctes[1],
          `complex_cte (
            user_id,
            "full name",
            calculated_field,
            metadata_json
          )`,
          1,
          "Second CTE with complex multi-line column list",
        )
        assertCTE(ctes[2], "no_columns_cte", 2, "Third CTE without column list")
      })
    })
  })

  describe("CTE Cross-References", () => {
    it("should handle simple sequential CTE references", () => {
      const sql = `with
        base_data as (
          select 1 as id, 'test' as name
        ),
        filtered_data as (
          select * from base_data where id > 0
        ),
        final_data as (
          select id, upper(name) as name from filtered_data
        )
      select * from final_data`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(3)
      assertCTE(ctes[0], "base_data", 0, "CTE with hardcoded test data")
      assertCTE(ctes[1], "filtered_data", 1, "CTE filtering data from base_data CTE")
      assertCTE(ctes[2], "final_data", 2, "CTE transforming data from filtered_data CTE")
    })

    it("should handle CTE references with joins", () => {
      const sql = `with
        orders as (
          select 1 as order_id, 100 as customer_id
        ),
        customers as (
          select 100 as id, 'John' as name
        ),
        order_details as (
          select o.order_id, c.name
          from orders o
          join customers c on o.customer_id = c.id
        )
      select * from order_details`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(3)
      assertCTE(ctes[0], "orders", 0, "CTE with order and customer ID data")
      assertCTE(ctes[1], "customers", 1, "CTE with customer ID and name data")
      assertCTE(ctes[2], "order_details", 2, "CTE joining orders and customers CTEs")
    })

    it("should handle CTE references with comments and quotes", () => {
      const sql = `with
        source_data as (
          select id, name -- 'source' data extraction
          from raw_table
        ),
        cleaned_data as (
          /* Reference to 'source_data' CTE */
          select * from source_data
          where name is not null
        )
      select * from cleaned_data`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(2)
      assertCTE(ctes[0], "source_data", 0, "CTE with line comment containing single quotes")
      assertCTE(ctes[1], "cleaned_data", 1, "CTE referencing source_data with block comment containing quotes")
    })

    it("should handle multiple CTE references in one query", () => {
      const sql = `with
        cte_a as (
          select 1 as id, 'A' as source
        ),
        cte_b as (
          select 2 as id, 'B' as source
        ),
        cte_combined as (
          select * from cte_a
          union all
          select * from cte_b
        )
      select * from cte_combined`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(3)
      assertCTE(ctes[0], "cte_a", 0, "CTE with ID 1 and source A")
      assertCTE(ctes[1], "cte_b", 1, "CTE with ID 2 and source B")
      assertCTE(ctes[2], "cte_combined", 2, "CTE combining cte_a and cte_b with UNION ALL")
    })

    it("should handle nested CTE references with subqueries", () => {
      const sql = `with
        base as (
          select id, amount from transactions
        ),
        aggregated as (
          select id, sum(amount) as total
          from base
          group by id
        ),
        ranked as (
          select *,
                 (select count(*) from aggregated a2 where a2.total > aggregated.total) as rank
          from aggregated
        )
      select * from ranked`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(3)
      assertCTE(ctes[0], "base", 0, "CTE selecting ID and amount from transactions table")
      assertCTE(ctes[1], "aggregated", 1, "CTE grouping base CTE data by ID with sum")
      assertCTE(ctes[2], "ranked", 2, "CTE adding rank using correlated subquery on aggregated CTE")
    })
  })

  describe("Edge Cases", () => {
    it("should handle no CTEs", () => {
      const sql = "select * from my_table"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(0)
    })

    it("should handle empty WITH clause", () => {
      const sql = "with select * from my_table"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(0)
    })

    it("should handle complex nested queries", () => {
      const sql = `with my_cte as (
        select id, (
          select count(*) 
          from other_table 
          where other_table.id = main_table.id
        ) as count
        from main_table
      ) select * from my_cte`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with correlated subquery counting from other table")

    })

    it("should handle unterminated comments gracefully", () => {
      const sql = "with source /* unterminated comment as (select 1) select * from source"
      const document = sql

      const ctes = detectCtes(document)

      // The comment swallows the rest of the text, so there is no CTE to find.
      expect(ctes).toEqual([])
    })
  })

  describe("CTE Range and Content Validation", () => {
    it("should provide correct ranges for CTE name and query", () => {
      const sql = "with my_cte as (select 1 as id) select * from my_cte"
      const document = sql

      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      const cte = ctes[0]

      // Verify basic range structure is defined
      expect(typeof cte.nameStart).toBe("number")
      expect(typeof cte.queryStart).toBe("number")
      expect(cte.nameStart).toBeDefined()
      expect(cte.nameEnd).toBeDefined()
      expect(cte.queryStart).toBeDefined()
      expect(cte.queryEnd).toBeDefined()

      // Verify the CTE name was extracted correctly
      expect(cte.name).toBe("my_cte")
      expect(cte.index).toBe(0)
      expect(typeof cte.withClauseStart).toBe("number")
    })

    it("should detect complex CTEs correctly", () => {
      const sql = `with
        orders_summary as (
          select 
            customer_id,
            count(*) as order_count,
            sum(total_amount) as total_spent
          from orders
          where status = 'completed'
          group by customer_id
        )
      select * from orders_summary`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "orders_summary", 0, "CTE with aggregated customer order data")

      // Verify range structure is correct
      expect(typeof ctes[0].queryStart).toBe("number")
    })

    it("should handle CTE detection with comments correctly", () => {
      const sql = `with my_cte as (
        select 
          id,
          name, -- This is a comment with quotes 'inside'
          /* Another comment */ 
          status
        from users
        {# Jinja comment with 'quotes' #}
        where active = true
      ) select * from my_cte`

      const document = sql
      const ctes = detectCtes(document)

      expect(ctes).toHaveLength(1)
      assertCTE(ctes[0], "my_cte", 0, "CTE with line, block, and Jinja comments containing quotes")

      // Verify that CTE was detected despite comments with quotes
      expect(ctes[0].name).toBe("my_cte")
      expect(typeof ctes[0].queryStart).toBe("number")
    })
  })
})

describe("detectCtes offsets", () => {
  it("returns offsets that slice the name and the body", () => {
    const sql = "with my_cte as (select 1 as id) select * from my_cte"
    const [cte] = detectCtesInText(sql)
    expect(sql.slice(cte.nameStart, cte.nameEnd)).toBe("my_cte")
    expect(sql.slice(cte.queryStart, cte.queryEnd)).toBe("select 1 as id")
    expect(cte.withClauseStart).toBe(0)
  })

  it("keeps the column list in the name", () => {
    const sql = "with my_cte (id, name) as (select 1, 'test') select * from my_cte"
    const [cte] = detectCtesInText(sql)
    expect(cte.name).toBe("my_cte (id, name)")
    expect(stripColumnList(cte.name)).toBe("my_cte")
  })

  it("does not detect a WITH inside a comment or string", () => {
    const sql = "-- with fake as (select 1)\nselect 'with x as (select 2)' as s from t"
    expect(detectCtesInText(sql)).toEqual([])
  })

  it("lists the CTEs of each top-level WITH, each with its own clause", () => {
    const sql = "with a as (select 1) with b as (select 2) select * from b"
    const ctes = detectCtesInText(sql)
    expect(ctes.map((c) => [c.name, c.index])).toEqual([["a", 0], ["b", 0]])
    expect(ctes[0].withClauseStart).not.toBe(ctes[1].withClauseStart)
  })

  it("lists only the model's own CTEs: a WITH inside a CTE body is part of that body", () => {
    const sql = `with outer_cte as (
  with inner_cte as (select 1 as x)
  select x from inner_cte
),
last as (select * from outer_cte)
select * from last`
    const ctes = detectCtesInText(sql)
    expect(ctes.map((c) => [c.name, c.index])).toEqual([["outer_cte", 0], ["last", 1]])
    // The outer CTE's count query carries its nested WITH whole and closes every parenthesis.
    const query = buildCountQuery(sql, ctes, ctes[1])!
    expect(query).toContain("inner_cte as (select 1 as x)")
    expect(query.match(/\(/g)!.length).toBe(query.match(/\)/g)!.length)
    expect(query).toEndWith("SELECT COUNT(*) AS _profile_count FROM last")
  })

  it("a WITH inside a subquery or a window definition is not a model CTE", () => {
    const sql = "select * from (with s as (select 1) select * from s) t join u on true window w as (partition by a)"
    expect(detectCtesInText(sql)).toEqual([])
  })

  it("comment markers and CTE-like text inside string literals neither hide nor add CTEs", () => {
    expect(detectCtesInText("with a as (select '--' as s), b as (select 2) select * from b").map((c) => c.name)).toEqual(["a", "b"])
    expect(detectCtesInText("with a as (select '/*' as s), b as (select '*/' as t) select * from b").map((c) => c.name)).toEqual(["a", "b"])
    expect(detectCtesInText("with a as (select '(x)' as s, 'fake as (select 2)' as t) select * from a").map((c) => c.name)).toEqual(["a"])
    expect(detectCtesInText("with a as (select 'it''s ) as (' as s), b as (select 2) select * from b").map((c) => c.name)).toEqual(["a", "b"])
  })

  it("a quoted name keeps its escaped quote", () => {
    const sql = 'with "a""b" as (select 1), `c``d` as (select 2) select * from "a""b"'
    expect(detectCtesInText(sql).map((c) => c.name)).toEqual(['"a""b"', "`c``d`"])
  })

  it("keeps CTEs that follow a Jinja tag between them, and reads WITH RECURSIVE and MATERIALIZED", () => {
    const jinja = "with a as (select 1),\n{% if x %}\nb as (select 2),\n{% endif %}\nc as (select 3)\nselect * from c"
    expect(detectCtesInText(jinja).map((c) => c.name)).toEqual(["a", "b", "c"])
    expect(detectCtesInText("with recursive r as (select 1) select * from r").map((c) => c.name)).toEqual(["r"])
    expect(detectCtesInText("with m as materialized (select 1), n as not materialized (select 2) select 1").map((c) => c.name)).toEqual(["m", "n"])
  })

  it("scans in linear time: a 2 MB model is read in well under a second", () => {
    const body = "select a, b, c from t where x = 1 and y = 'it''s' -- note\n"
    const sql = `with big as (\n${body.repeat(Math.floor(2_000_000 / body.length))}) select * from big`
    const started = performance.now()
    expect(detectCtesInText(sql).map((c) => c.name)).toEqual(["big"])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("keeps WITH RECURSIVE in the count query, and a WITH written inside a Jinja block is not the model's", () => {
    const recursive = "with recursive r as (select 1 as n union all select n + 1 from r where n < 3) select * from r"
    const ctes = detectCtesInText(recursive)
    expect(buildCountQuery(recursive, ctes, ctes[0])).toStartWith("with recursive r as (")
    const block = "{% set q %}with z as (select 1) select * from z{% endset %}\nwith a as (select 1), b as (select 2) select * from b"
    const found = detectCtesInText(block)
    expect(found.map((c) => c.name)).toEqual(["a", "b"])
    expect(buildCountQuery(block, found, found[1])).toContain("b as (select 2)")
    const inline = "{% set q = 'with z as (select 1)' %}\nwith a as (select 1) select * from a"
    expect(detectCtesInText(inline).map((c) => c.name)).toEqual(["a"])
    const macro = "{% macro m() %}with z as (select 1) select * from z{% endmacro %}\nwith a as (select 1) select * from a"
    expect(detectCtesInText(macro).map((c) => c.name)).toEqual(["a"])
  })

  it("reads $ and non-ASCII letters in a name, and survives crafted input in linear time", () => {
    expect(detectCtesInText("with my$cte as (select 1), é_t as (select 2) select * from é_t").map((c) => c.name)).toEqual(["my$cte", "é_t"])
    for (const unit of ["with [", "with {%", "with ((", "with a as (", "with '", "with /*", "with \"x"]) {
      const started = performance.now()
      detectCtesInText(unit.repeat(200_000))
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })
})

describe("buildCountQuery", () => {
  const sql = [
    "{{ config(materialized='table') }}",
    "",
    "with orders as (select * from {{ ref('stg_orders') }}),",
    "customers as (select * from {{ ref('stg_customers') }}),",
    "joined as (select o.id from orders o join customers c on o.cid = c.id)",
    "select * from joined",
  ].join("\n")

  it("keeps the preamble and every earlier CTE up to the target", () => {
    const ctes = detectCtesInText(sql)
    expect(ctes.map((c) => c.name)).toEqual(["orders", "customers", "joined"])
    const query = buildCountQuery(sql, ctes, ctes[1])!
    expect(query.startsWith("{{ config(materialized='table') }}")).toBe(true)
    expect(query).toContain("with orders as (")
    expect(query).toContain("customers as (")
    expect(query).not.toContain("joined")
    expect(query.endsWith("SELECT COUNT(*) AS _profile_count FROM customers")).toBe(true)
  })

  it("counts the last CTE with all of its inputs", () => {
    const ctes = detectCtesInText(sql)
    const query = buildCountQuery(sql, ctes, ctes[2])!
    expect(query).toContain("joined as (")
    expect(query).toContain("from orders o join customers c")
    expect(query.endsWith("FROM joined")).toBe(true)
  })

  it("keeps a column list in the definition but not in the FROM clause", () => {
    const text = "with a (x, y) as (select 1, 2) select * from a"
    const ctes = detectCtesInText(text)
    const query = buildCountQuery(text, ctes, ctes[0])!
    expect(query).toContain("with a (x, y) as (")
    expect(query.endsWith("FROM a")).toBe(true)
  })

  it("builds no query for a CTE of a second WITH clause, whose preamble would hold the first clause's query", () => {
    const text = "with a as (select 1) select * from a;\nwith b as (select 2) select * from b"
    const ctes = detectCtesInText(text)
    expect(buildCountQuery(text, ctes, ctes.find((c) => c.name === "a")!)).toContain("with a as (")
    expect(buildCountQuery(text, ctes, ctes.find((c) => c.name === "b")!)).toBeUndefined()
  })

  it("returns undefined for a CTE that is not in the list", () => {
    expect(
      buildCountQuery("select 1", [], {
        name: "x",
        nameStart: 0,
        nameEnd: 1,
        queryStart: 0,
        queryEnd: 0,
        index: 0,
        withClauseStart: 0,
      }),
    ).toBeUndefined()
  })
})

describe("count query edge cases", () => {
  it("keeps Jinja written between CTEs, and reports a block left open by the cut", () => {
    const kept = "{% set n = 2 %}\nwith a as (select {{ n }}),\n{% if true %}b as (select 2),{% endif %}\nc as (select 3) select * from c"
    const ctes = detectCtesInText(kept)
    expect(buildCountQuery(kept, ctes, ctes[2])).toContain("{% if true %}b as (select 2),{% endif %}")
    expect(unclosedJinjaBlock(buildCountQuery(kept, ctes, ctes[2])!)).toBeUndefined()
    const open = "{% if x %}\nwith a as (select 1) select * from a\n{% endif %}"
    const found = detectCtesInText(open)
    expect(unclosedJinjaBlock(buildCountQuery(open, found, found[0])!)).toBe("if")
    expect(unclosedJinjaBlock("{% set q %}x")).toBe("set")
    expect(unclosedJinjaBlock("{% raw %}{% if x %}{% endraw %}")).toBeUndefined()
    expect(unclosedJinjaBlock("{% block body %}with a as (select 1)")).toBe("block")
    expect(unclosedJinjaBlock("{% if x %}a{%+ endif %}")).toBeUndefined()
    expect(unclosedJinjaBlock("{% set (a, b) = (1, 2) %}x")).toBeUndefined()
  })

  it("matches nested set blocks to their own end tag", () => {
    const sql = "{% set outer %}{% set inner %}with fake as (select 1){% endset %}x{% endset %}\nwith real as (select 2) select * from real"
    expect(detectCtesInText(sql).map((c) => c.name)).toEqual(["real"])
  })

  it("reads a comment or Jinja tag between AS, NOT and MATERIALIZED and the body", () => {
    expect(detectCtesInText("with a as /* c */ (select 1), b as not /* c */ materialized (select 2) select 1").map((c) => c.name)).toEqual(["a", "b"])
    expect(detectCtesInText("with a /* c */ as {# j #} materialized -- x\n(select 1) select 1").map((c) => c.name)).toEqual(["a"])
  })

  it("strips a column list that holds a quoted ')' or a comment", () => {
    expect(stripColumnList('a ("x)")')).toBe("a")
    expect(stripColumnList("a (x /* ) */)")).toBe("a")
    expect(stripColumnList("Big Spenders")).toBe("Big Spenders")
    const text = 'with a ("x)", y) as (select 1, 2) select * from a'
    const ctes = detectCtesInText(text)
    expect(buildCountQuery(text, ctes, ctes[0])).toEndWith("FROM a")
  })

  it("a dollar-quoted string does not end the CTE body early", () => {
    const text = "with a as (select $$ ) $$ as s), b as (select $tag$ ( $tag$ as t) select 1"
    expect(detectCtesInText(text).map((c) => c.name)).toEqual(["a", "b"])
  })

  it("tags inside a Jinja comment are not blocks, and a % inside a tag does not hide it", () => {
    expect(unclosedJinjaBlock("{# {% if x %} #}with a as (select 1)")).toBeUndefined()
    expect(unclosedJinjaBlock("{% if x %}{# {% endif %} #}with a as (select 1)")).toBe("if")
    expect(unclosedJinjaBlock("{% if x % 2 == 0 %}with a as (select 1)")).toBe("if")
    const sql = "{% set q %}{# {% endset %} #}with z as (select 1){% endset %}\nwith a as (select 2) select * from a"
    expect(detectCtesInText(sql).map((c) => c.name)).toEqual(["a"])
  })

  it("counts open Jinja blocks in linear time: 100k tags in a second", () => {
    const sql = "{% if x %}".repeat(100_000) + "{% endfor %}".repeat(100_000)
    const started = performance.now()
    expect(unclosedJinjaBlock(sql)).toBe("if")
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("unterminated tags, comments and many block tags are scanned in linear time", () => {
    for (const unit of ["{% if x ", "{# c ", "{% set q %}", "{% set q | upper %}"]) {
      const sql = unit.repeat(100_000) + "with a as (select 1) select 1"
      const started = performance.now()
      unclosedJinjaBlock(sql)
      detectCtesInText(sql)
      expect(performance.now() - started).toBeLessThan(1500)
    }
  })

  it("a filtered set block is a block, and raw text holds no tags", () => {
    expect(unclosedJinjaBlock("{% set q | upper %}x")).toBe("set")
    expect(unclosedJinjaBlock("{% set q = 1 | upper %}x")).toBeUndefined()
    const sql = "{% set q %}{% raw %}{% endset %}{% endraw %}with z as (select 1){% endset %}\nwith a as (select 2) select * from a"
    expect(detectCtesInText(sql).map((c) => c.name)).toEqual(["a"])
  })

  it("a dollar-quote tag may hold digits", () => {
    expect(detectCtesInText("with a as (select $f1$ ) $f1$ as s), b as (select 2) select 1").map((c) => c.name)).toEqual(["a", "b"])
  })

  it("writes a name with $ or a non-ASCII letter as it was declared", () => {
    for (const name of ["my$cte", "Ünits"]) {
      const text = `with ${name} as (select 1) select * from ${name}`
      const ctes = detectCtesInText(text)
      expect(buildCountQuery(text, ctes, ctes[0])).toEndWith(`FROM ${name}`)
    }
  })
})

describe("quoteSqlIdentifier", () => {
  it("leaves plain, quoted and dotted names alone and quotes the rest", () => {
    expect(quoteSqlIdentifier("my_cte")).toBe("my_cte")
    expect(quoteSqlIdentifier('"My Cte"')).toBe('"My Cte"')
    expect(quoteSqlIdentifier("`x`")).toBe("`x`")
    expect(quoteSqlIdentifier("[x]")).toBe("[x]")
    expect(quoteSqlIdentifier("a.b")).toBe("a.b")
    expect(quoteSqlIdentifier("my-cte")).toBe('"my-cte"')
  })

  it("is applied to a quoted CTE name in the count query", () => {
    const text = 'with "My Cte" as (select 1) select * from "My Cte"'
    const ctes = detectCtesInText(text)
    expect(buildCountQuery(text, ctes, ctes[0])!.endsWith('FROM "My Cte"')).toBe(true)
  })
})

describe("extractRowCount", () => {
  it("reads the count by position for upper- and lower-case aliases", () => {
    expect(extractRowCount([{ _PROFILE_COUNT: 99 }])).toBe(99)
    expect(extractRowCount([{ _profile_count: 42 }])).toBe(42)
  })

  it("coerces string counts", () => {
    expect(extractRowCount([{ _PROFILE_COUNT: "1234" }])).toBe(1234)
  })

  it("returns 0 for no rows, a missing value or a non-numeric value", () => {
    expect(extractRowCount([])).toBe(0)
    expect(extractRowCount(undefined)).toBe(0)
    expect(extractRowCount([{ _PROFILE_COUNT: "not-a-number" }])).toBe(0)
  })
})
