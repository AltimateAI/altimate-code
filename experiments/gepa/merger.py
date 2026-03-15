"""Structure-aware prompt merging for GEPA prompt optimization.

Takes two parent prompts and their associated lessons, then produces a merged
prompt that integrates the lessons into the appropriate structural sections
of builder.txt.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import anthropic

from .reflector import Lesson

logger = logging.getLogger(__name__)

# The known structural sections of builder.txt that the merger must preserve
REQUIRED_SECTIONS = [
    "Pre-Execution Protocol",
    "dbt Verification Workflow",
    "Self-Review Before Completion",
    "Available Skills",
    "FinOps & Governance Tools",
]

MERGE_SYSTEM_PROMPT = """\
You are an expert prompt engineer specializing in data engineering agent prompts.
Your task is to merge two parent prompts and integrate lessons learned from \
benchmark failures into a single improved prompt.

## Rules

1. **Preserve structure**: The prompt MUST contain these sections:
   - Pre-Execution Protocol
   - dbt Verification Workflow
   - Self-Review Before Completion
   - Available Skills
   - FinOps & Governance Tools

2. **Integrate, don't concatenate**: Lessons should be woven into the \
appropriate existing sections. Do NOT add a separate "lessons learned" section.

3. **Resolve conflicts**: If two lessons contradict each other, prefer the one \
categorized as "additive" over "modifying". If both are the same category, \
synthesize them into a single coherent instruction.

4. **Maintain tone**: The prompt should read like a single coherent document, \
not a patchwork. Match the existing writing style (direct, imperative, concise).

5. **No bloat**: If a lesson is redundant with existing content, skip it. \
The merged prompt should be at most 20% longer than the longer parent.

6. **Keep skills and tools lists intact**: Do not remove or rename any tools, \
skills, or their descriptions unless a lesson explicitly calls for it.

7. **No benchmark-specific content**: Lessons must be stated as general data \
engineering best practices. Do NOT include references to specific dataset names, \
instance IDs, or benchmark task details. Frame everything as general rules \
that would help on ANY data engineering project.

8. **Output ONLY the merged prompt text**: No commentary, no markdown fences, \
no explanation. Just the prompt."""

MERGE_USER_TEMPLATE = """\
## Parent Prompt 1 (ID: {parent1_id}, solved {parent1_solved} instances)
```
{parent1_text}
```

## Lessons from Parent 1's failures:
{lessons1_text}

## Parent Prompt 2 (ID: {parent2_id}, solved {parent2_solved} instances)
```
{parent2_text}
```

## Lessons from Parent 2's failures:
{lessons2_text}

## Instructions
Merge these two prompts and their lessons into a single improved prompt. \
Integrate lessons into the appropriate structural sections. \
Preserve all required sections. Output ONLY the merged prompt text."""


def merge_prompts(
    parent1_text: str,
    parent2_text: str,
    lessons1: list[Lesson],
    lessons2: list[Lesson],
    parent1_id: str = "parent1",
    parent2_id: str = "parent2",
    parent1_solved: int = 0,
    parent2_solved: int = 0,
    model: str = "claude-sonnet-4-20250514",
) -> str:
    """Merge two parent prompts with lessons into a new prompt variant.

    Args:
        parent1_text: Text of the first parent prompt.
        parent2_text: Text of the second parent prompt.
        lessons1: Lessons from parent 1's failure analysis.
        lessons2: Lessons from parent 2's failure analysis.
        parent1_id: ID of parent 1 (for logging).
        parent2_id: ID of parent 2 (for logging).
        parent1_solved: Number of instances parent 1 solved.
        parent2_solved: Number of instances parent 2 solved.
        model: Anthropic model to use.

    Returns:
        The merged prompt text.

    Raises:
        ValueError: If the merged prompt is missing required sections.
    """
    client = anthropic.Anthropic()

    lessons1_text = _format_lessons(lessons1) if lessons1 else "No lessons available."
    lessons2_text = _format_lessons(lessons2) if lessons2 else "No lessons available."

    user_message = MERGE_USER_TEMPLATE.format(
        parent1_id=parent1_id,
        parent1_solved=parent1_solved,
        parent1_text=parent1_text,
        lessons1_text=lessons1_text,
        parent2_id=parent2_id,
        parent2_solved=parent2_solved,
        parent2_text=parent2_text,
        lessons2_text=lessons2_text,
    )

    logger.info(
        "Merging prompts %s (%d solved) + %s (%d solved) with %d + %d lessons",
        parent1_id, parent1_solved, parent2_id, parent2_solved,
        len(lessons1), len(lessons2),
    )

    response = client.messages.create(
        model=model,
        max_tokens=8192,
        temperature=0,
        system=MERGE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    merged_text = response.content[0].text.strip()

    # Strip markdown code fences if present
    if merged_text.startswith("```"):
        lines = merged_text.split("\n")
        # Find start and end of code block
        start = 1  # skip first ``` line
        end = len(lines)
        for i in range(len(lines) - 1, 0, -1):
            if lines[i].strip() == "```":
                end = i
                break
        merged_text = "\n".join(lines[start:end]).strip()

    # Validate required sections
    _validate_sections(merged_text)

    # Validate length (should not be more than 20% longer than longer parent)
    max_parent_len = max(len(parent1_text), len(parent2_text))
    if len(merged_text) > max_parent_len * 1.5:
        logger.warning(
            "Merged prompt is %.0f%% longer than longest parent (%d vs %d chars). "
            "Consider tightening the merge.",
            (len(merged_text) / max_parent_len - 1) * 100,
            len(merged_text),
            max_parent_len,
        )

    logger.info(
        "Merged prompt: %d chars (%+d from parent1, %+d from parent2)",
        len(merged_text),
        len(merged_text) - len(parent1_text),
        len(merged_text) - len(parent2_text),
    )

    return merged_text


def _format_lessons(lessons: list[Lesson]) -> str:
    """Format lessons into a readable text block for the merge prompt."""
    lines = []
    for i, lesson in enumerate(lessons, 1):
        lines.append(
            f"{i}. [{lesson.category.upper()}] Instance: {lesson.instance_id}\n"
            f"   Diagnosis: {lesson.diagnosis}\n"
            f"   Instruction: {lesson.instruction}"
        )
    return "\n\n".join(lines)


def _validate_sections(prompt_text: str) -> None:
    """Validate that the merged prompt contains all required sections.

    Raises ValueError if any required section is missing.
    """
    missing = []
    for section in REQUIRED_SECTIONS:
        # Check for section header (## or plain text match)
        if section.lower() not in prompt_text.lower():
            missing.append(section)

    if missing:
        raise ValueError(
            f"Merged prompt is missing required sections: {', '.join(missing)}. "
            "The merge LLM may need a retry."
        )
