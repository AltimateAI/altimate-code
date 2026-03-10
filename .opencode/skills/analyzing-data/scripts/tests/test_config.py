"""Tests for config.py - path utilities."""

from pathlib import Path
from unittest.mock import patch
import warnings


class TestConfigPaths:
    """Tests for configuration path functions."""

    def test_get_kernel_venv_dir_new_path(self):
        """Test kernel venv dir returns new path when no legacy exists."""
        import config as config_module

        config_module._legacy_warning_shown = False

        with patch.object(Path, "exists", return_value=False):
            result = config_module.get_kernel_venv_dir()
            assert isinstance(result, Path)
            assert result.parts[-3:] == (".astro", "agents", "kernel_venv")

    def test_get_kernel_connection_file_new_path(self):
        """Test kernel connection file returns new path when no legacy exists."""
        import config as config_module

        config_module._legacy_warning_shown = False

        with patch.object(Path, "exists", return_value=False):
            result = config_module.get_kernel_connection_file()
            assert isinstance(result, Path)
            assert result.name == "kernel.json"
            assert result.parts[-3:-1] == (".astro", "agents")

    def test_get_config_dir_new_path(self):
        """Test config dir returns new path when no legacy exists."""
        import config as config_module

        config_module._legacy_warning_shown = False

        with patch.object(Path, "exists", return_value=False):
            result = config_module.get_config_dir()
            assert isinstance(result, Path)
            assert result.parts[-2:] == (".astro", "agents")


class TestLegacyPathFallback:
    """Tests for backward compatibility with legacy path."""

    def test_get_config_dir_uses_legacy_when_exists(self):
        """Test that legacy path is used when it exists and new path doesn't."""
        import config as config_module

        config_module._legacy_warning_shown = False

        def mock_exists(self):
            # Legacy path exists, new path doesn't
            path_str = str(self)
            if ".astro/ai/config" in path_str:
                return True
            if ".astro/agents" in path_str:
                return False
            return False

        with patch.object(Path, "exists", mock_exists):
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                result = config_module.get_config_dir()

                assert result.parts[-3:] == (".astro", "ai", "config")
                assert len(w) == 1
                assert issubclass(w[0].category, DeprecationWarning)
                assert "Deprecated config path" in str(w[0].message)

    def test_get_config_dir_prefers_new_path(self):
        """Test that new path is used when both exist."""
        import config as config_module

        config_module._legacy_warning_shown = False

        def mock_exists(self):
            # Both paths exist - should prefer new path
            path_str = str(self)
            if ".astro/ai/config" in path_str:
                return True
            if ".astro/agents" in path_str:
                return True
            return False

        with patch.object(Path, "exists", mock_exists):
            result = config_module.get_config_dir()
            # New path should be preferred when both exist
            assert result.parts[-2:] == (".astro", "agents")

    def test_legacy_warning_shown_once(self):
        """Test that deprecation warning is only shown once."""
        import config as config_module

        config_module._legacy_warning_shown = False

        def mock_exists(self):
            path_str = str(self)
            if ".astro/ai/config" in path_str:
                return True
            if ".astro/agents" in path_str:
                return False
            return False

        with patch.object(Path, "exists", mock_exists):
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                # Call multiple times
                config_module.get_config_dir()
                config_module.get_config_dir()
                config_module.get_config_dir()

                # Should only have one warning
                deprecation_warnings = [
                    x for x in w if issubclass(x.category, DeprecationWarning)
                ]
                assert len(deprecation_warnings) == 1

    def test_kernel_paths_use_legacy_parent(self):
        """Test that kernel paths use legacy parent dir when legacy config exists."""
        import config as config_module

        config_module._legacy_warning_shown = False

        def mock_exists(self):
            path_str = str(self)
            if ".astro/ai/config" in path_str:
                return True
            if ".astro/agents" in path_str:
                return False
            return False

        with patch.object(Path, "exists", mock_exists):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                venv_dir = config_module.get_kernel_venv_dir()
                conn_file = config_module.get_kernel_connection_file()

                # Should be under ~/.astro/ai/ (legacy parent)
                assert venv_dir.parts[-3:] == (".astro", "ai", "kernel_venv")
                assert conn_file.parts[-3:] == (".astro", "ai", "kernel.json")
