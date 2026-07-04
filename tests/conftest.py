"""Shared pytest configuration."""

import pytest


# Make all tests async-compatible without decorator
pytest_plugins = ["pytest_asyncio"]
