import xxhash


def stream_xxh3_128(stream, chunk: int = 65536) -> str:
    h = xxhash.xxh3_128()
    while True:
        b = stream.read(chunk)
        if not b:
            break
        h.update(b)
    return h.hexdigest()
