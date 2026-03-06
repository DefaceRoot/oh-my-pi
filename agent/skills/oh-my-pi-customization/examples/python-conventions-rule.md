---
description: Python project conventions
globs: ["*.py", "**/*.py"]
---

# Python Conventions

<critical>
These conventions MUST be followed for all Python code in this project.
</critical>

## Type Hints
- ALL function parameters must have type hints
- ALL return types must be specified
- Use `Optional[T]` for nullable types, not `T | None`

## Imports
- Use absolute imports, not relative
- Group imports: stdlib, third-party, local (separated by blank lines)
- Sort alphabetically within groups

## Naming
- Classes: PascalCase
- Functions/variables: snake_case
- Constants: UPPER_SNAKE_CASE
- Private: prefix with single underscore

## Error Handling
- Use specific exception types, not bare `except:`
- Always log exceptions with context
- Re-raise with `raise ... from e` to preserve stack trace

## Documentation
- All public functions need docstrings
- Use Google-style docstrings
- Include Args, Returns, Raises sections

## Example

```python
from pathlib import Path
from typing import Optional

import requests

from myproject.config import settings


class DataProcessor:
    """Process data from external sources."""
    
    def fetch_data(self, url: str, timeout: Optional[int] = None) -> dict:
        """Fetch data from a URL.
        
        Args:
            url: The URL to fetch from.
            timeout: Request timeout in seconds.
            
        Returns:
            Parsed JSON response as dictionary.
            
        Raises:
            requests.RequestException: If the request fails.
        """
        response = requests.get(url, timeout=timeout or settings.DEFAULT_TIMEOUT)
        response.raise_for_status()
        return response.json()
```
