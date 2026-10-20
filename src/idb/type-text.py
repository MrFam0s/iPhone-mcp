"""Send text through the selected simulator's active keyboard, never a clipboard.
The entire input is validated before sending any event. Unsupported layouts or
characters fail explicitly instead of silently producing a different string.
"""
import asyncio
import logging
import plistlib
import sys
from pathlib import Path

class UnsupportedText(ValueError):
    pass

# USB HID usages for the iOS German hardware layout. Modifiers are explicit,
# avoiding fb-idb's US-only text conversion. Restrict to verified characters.
GERMAN_KEYS = {
    'ä': (52, False), 'ö': (51, False), 'ü': (47, False), 'ß': (45, False),
    'Ä': (52, True), 'Ö': (51, True), 'Ü': (47, True),
    ' ': (44, False), '\n': (40, False), '\t': (43, False),
    '.': (55, False), ',': (54, False), '-': (56, False), '_': (56, True),
    '!': (30, True), '?': (45, True), ';': (54, True), ':': (55, True),
    '+': (48, False), '*': (48, True), '/': (36, True), '&': (35, True),
    '(': (37, True), ')': (38, True), '=': (39, True), '%': (34, True),
    '$': (33, True), '"': (31, True), "'": (49, True), '#': (49, False),
    # Modifier bits: 1 = Shift, 2 = Option.
    '@': (15, 2), '€': (8, 2), '~': (17, 2), '[': (34, 2), ']': (35, 2),
    '{': (37, 2), '}': (38, 2), '|': (36, 2), '\\': (36, 3),
    '<': (53, False), '>': (53, True),
}

def keyboard_layout(udid, home=None):
    path = Path(home or Path.home()) / 'Library/Developer/CoreSimulator/Devices' / udid / 'data/Library/Preferences/com.apple.keyboard.preferences.plist'
    with path.open('rb') as stream:
        current = plistlib.load(stream).get('KeyboardsCurrentAndNext', [])[0]
    if current.startswith('de_DE@sw=QWERTZ-German;hw=Automatic'):
        return 'de-DE'
    if current.startswith('en_US@sw=QWERTY;hw=Automatic'):
        return 'en-US'
    raise UnsupportedText('Unsupported active simulator keyboard')

def german_keys(text):
    result = []
    for char in text:
        if char.isascii() and char.isalpha():
            letter = {'y': 'z', 'z': 'y'}.get(char.lower(), char.lower())
            result.append((4 + ord(letter) - ord('a'), char.isupper()))
        elif char in '1234567890':
            result.append((30 + '1234567890'.index(char), False))
        elif char in GERMAN_KEYS:
            result.append(GERMAN_KEYS[char])
        else:
            raise UnsupportedText('Character is not supported by the active simulator keyboard')
    return result

def text_events(text, layout):
    from idb.common.hid import KEY_MAP, text_to_events
    from idb.common.types import HIDPress, HIDKey, HIDDirection
    if layout == 'en-US':
        if any(char not in KEY_MAP for char in text):
            raise UnsupportedText('Character is not supported by the active simulator keyboard')
        return list(text_to_events(text))
    keys = german_keys(text)  # Validate every character before emitting anything.
    events = []
    def press(key, down):
        events.append(HIDPress(action=HIDKey(keycode=key), direction=HIDDirection.DOWN if down else HIDDirection.UP))
    for key, modifiers in keys:
        if modifiers & 2: press(226, True)
        if modifiers & 1: press(225, True)
        press(key, True)
        press(key, False)
        if modifiers & 1: press(225, False)
        if modifiers & 2: press(226, False)
    return events

async def main():
    from idb.grpc.client import Client
    from idb.common.types import DomainSocketAddress
    socket, udid = sys.argv[1:3]
    text = sys.stdin.buffer.read().decode('utf-8')
    events = text_events(text, keyboard_layout(udid))
    async with Client.build(address=DomainSocketAddress(path=socket),
                            logger=logging.getLogger('blitz-text'), exchange_metadata=False) as client:
        if client.companion.udid.lower() != udid.lower():
            raise RuntimeError('Companion device does not match requested simulator')
        await asyncio.wait_for(client.send_events(events), timeout=10)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except (UnsupportedText, FileNotFoundError, IndexError):
        sys.stderr.write('Unsupported simulator keyboard layout or character\n')
        sys.exit(43)
    except Exception:
        # Do not print entered text or IDB debug diagnostics.
        sys.stderr.write('Simulator text input failed\n')
        sys.exit(1)
