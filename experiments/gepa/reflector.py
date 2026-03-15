"""LLM-driven failure analysis for GEPA prompt optimization.

Analyzes why a prompt failed on specific benchmark instances and produces
actionable lessons for prompt improvement.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, asdict
from typing import Any

import anthropic

logger = logging.getLogger(__name__)

REFLECTION_SYSTEM_PROMPT = """\
You are an expert prompt engineer analyzing why a data engineering agent failed \
on a task. Your job is to identify the general skill gap and produce a concrete \
instruction that would make the agent better at data engineering broadly.

Rules:
1. **No benchmark-specific fixes.** The instruction must improve the agent's \
general data engineering ability. It should help on ANY project, not just this task.
2. Be specific. Not "improve SQL handling" but "when joining tables, check if \
column names are SQL reserved keywords and quote them with double quotes."
3. The instruction must be self-contained — it will be inserted into the agent's \
system prompt as a new rule or modification to an existing rule.
4. Categorize as "additive" if this instruction helps solve NEW types of tasks \
without changing behavior on existing ones, or "modifying" if it changes how \
existing behavior works (which may help some tasks but risk regressing others).
5. Keep the instruction under 3 sentences.
6. Focus on the PROCESS failure (wrong approach, missing step, incorrect assumption) \
not on the specific data or schema involved. The lesson should transfer to \
completely different databases, schemas, and projects.
7. Do NOT reference specific table names, column names, instance IDs, or dataset \
details in the instruction. Frame everything in terms of general patterns."""

REFLECTION_USER_TEMPLATE = """\
## Current Agent Prompt
```
{prompt_text}
```

## Failed Task
**Task Description:**
{task_description}

**Agent's Error / Output:**
{agent_output}

## Analysis Request
The agent failed on this task. You do NOT have access to the correct answer — \
analyze the failure based solely on what the agent did wrong.

1. What general skill or process gap caused the agent to fail?
2. What instruction, added to the agent prompt, would fix this CLASS of failure \
across any data engineering project (not just this specific task)?
3. Is this instruction "additive" or "modifying"?

Respond in this exact JSON format:
{{
    "diagnosis": "One sentence explaining the general process failure",
    "instruction": "The general instruction to add to the prompt (no benchmark-specific details)",
    "category": "additive" or "modifying"
}}"""


@dataclass
class Lesson:
    """A single lesson learned from a failure analysis."""

    instance_id: str
    diagnosis: str
    instruction: str
    category: str  # "additive" | "modifying"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Lesson:
        return cls(
            instance_id=data["instance_id"],
            diagnosis=data["diagnosis"],
            instruction=data["instruction"],
            category=data["category"],
        )


def reflect_on_failure(
    prompt_text: str,
    instance_id: str,
    task_description: str,
    agent_output: str,
    model: str = "claude-sonnet-4-20250514",
) -> Lesson:
    """Analyze a single failure and produce an actionable lesson.

    The reflector intentionally does NOT receive the gold/expected answer.
    This ensures lessons are about general process improvements, not
    reverse-engineered from specific correct answers.

    Args:
        prompt_text: The current agent prompt that was used.
        instance_id: The benchmark instance ID that failed.
        task_description: Description of what the task required.
        agent_output: What the agent actually produced (including errors).
        model: Anthropic model to use for reflection.

    Returns:
        A Lesson with diagnosis, instruction, and category.
    """
    client = anthropic.Anthropic()

    user_message = REFLECTION_USER_TEMPLATE.format(
        prompt_text=prompt_text,
        task_description=task_description,
        agent_output=agent_output,
    )

    logger.info("Reflecting on failure for instance %s", instance_id)

    response = client.messages.create(
        model=model,
        max_tokens=1024,
        temperature=0,
        system=REFLECTION_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    response_text = response.content[0].text.strip()

    # Parse JSON from response (handle markdown code blocks)
    import json
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        # Remove first and last lines (``` markers)
        json_lines = []
        in_block = False
        for line in lines:
            if line.strip().startswith("```") and not in_block:
                in_block = True
                continue
            elif line.strip() == "```" and in_block:
                break
            elif in_block:
                json_lines.append(line)
        response_text = "\n".join(json_lines)

    parsed = json.loads(response_text)

    lesson = Lesson(
        instance_id=instance_id,
        diagnosis=parsed["diagnosis"],
        instruction=parsed["instruction"],
        category=parsed["category"],
    )

    logger.info(
        "Lesson for %s [%s]: %s",
        instance_id,
        lesson.category,
        lesson.instruction[:100],
    )
    return lesson


async def _reflect_one(
    semaphore: asyncio.Semaphore,
    prompt_text: str,
    instance_id: str,
    task_description: str,
    agent_output: str,
    model: str,
) -> Lesson:
    """Async wrapper for reflect_on_failure with concurrency control."""
    async with semaphore:
        # Run the synchronous API call in a thread pool
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            reflect_on_failure,
            prompt_text,
            instance_id,
            task_description,
            agent_output,
            model,
        )


def batch_reflect(
    prompt_text: str,
    failures: list[dict[str, str]],
    model: str = "claude-sonnet-4-20250514",
    max_concurrent: int = 5,
) -> list[Lesson]:
    """Reflect on multiple failures in parallel.

    Args:
        prompt_text: The current agent prompt.
        failures: List of dicts with keys:
            instance_id, task_description, agent_output
            (gold_answer is intentionally NOT included to prevent benchmark leakage)
        model: Anthropic model to use.
        max_concurrent: Max concurrent API calls.

    Returns:
        List of Lesson objects, one per failure.
    """
    if not failures:
        return []

    logger.info("Batch reflecting on %d failures (max_concurrent=%d)", len(failures), max_concurrent)

    async def _run() -> list[Lesson]:
        semaphore = asyncio.Semaphore(max_concurrent)
        tasks = [
            _reflect_one(
                semaphore=semaphore,
                prompt_text=prompt_text,
                instance_id=f["instance_id"],
                task_description=f.get("task_description", "No description available"),
                agent_output=f.get("agent_output", "No agent output available"),
                model=model,
            )
            for f in failures
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        lessons = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(
                    "Reflection failed for %s: %s",
                    failures[i]["instance_id"],
                    result,
                )
            else:
                lessons.append(result)
        return lessons

    return asyncio.run(_run())
