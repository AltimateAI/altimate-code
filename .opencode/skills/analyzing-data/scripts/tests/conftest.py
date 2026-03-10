"""Pytest configuration for analyzing-data skill tests."""

import sys
from pathlib import Path

# Add the scripts directory to the Python path for lib imports
scripts_dir = Path(__file__).parent.parent
sys.path.insert(0, str(scripts_dir))
