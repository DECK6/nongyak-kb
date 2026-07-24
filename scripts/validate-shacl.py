#!/usr/bin/env python3

import sys

try:
    from pyshacl import validate
except ModuleNotFoundError:
    print(
        "pyshacl is not installed. Install it with: "
        "python3 -m pip install pyshacl",
        file=sys.stderr,
    )
    raise SystemExit(2)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            "Usage: python3 scripts/validate-shacl.py data.ttl shapes.ttl",
            file=sys.stderr,
        )
        return 2

    conforms, _, report = validate(
        data_graph=argv[1],
        shacl_graph=argv[2],
        data_graph_format="turtle",
        shacl_graph_format="turtle",
    )
    if conforms:
        print("Conforms")
        return 0

    print(report)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
