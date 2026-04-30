"""Agent extension manifest for the mailai subapp/library.

The OS reads declarative tools.json first. This module is reserved for future
curated @function wrappers that need Python-side registration.
"""

from __future__ import annotations


def get_agent_extensions() -> dict:
    return {
        "subapp": "mailai",
        "function_wrappers": [],
        "status": "stub",
    }


__all__ = ["get_agent_extensions"]
