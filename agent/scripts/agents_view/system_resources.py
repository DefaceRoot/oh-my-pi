"""System resource sampling helpers for Agents View."""

from __future__ import annotations

_RESOURCE_CACHE: dict = {"ts": 0.0, "data": {}}


def _get_sys_resources() -> dict:
    import time as _t

    cached_age = _t.time() - float(_RESOURCE_CACHE.get("ts", 0.0) or 0.0)
    cached_data = _RESOURCE_CACHE.get("data", {})
    if cached_age < 5.0 and isinstance(cached_data, dict):
        return cached_data

    result: dict = {}
    try:
        import psutil  # type: ignore[import-untyped]

        result["cpu"] = float(psutil.cpu_percent(interval=None))
        mem = psutil.virtual_memory()
        result["mem"] = float(mem.percent)
    except ImportError:
        pass
    except Exception:
        pass

    if "mem" not in result:
        try:
            mem_info: dict[str, int] = {}
            with open("/proc/meminfo", encoding="utf-8") as meminfo_file:
                for line in meminfo_file:
                    parts = line.split()
                    if len(parts) >= 2:
                        mem_info[parts[0].rstrip(":")] = int(parts[1])
            total = mem_info.get("MemTotal", 0)
            available = mem_info.get("MemAvailable", mem_info.get("MemFree", 0))
            if total > 0:
                result["mem"] = (total - available) / total * 100
        except Exception:
            pass

    _RESOURCE_CACHE.update({"ts": _t.time(), "data": result})
    return result
