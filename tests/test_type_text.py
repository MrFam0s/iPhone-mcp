import importlib.util,plistlib,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('type_text',Path(__file__).parents[1]/'src/idb/type-text.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class TextTests(unittest.TestCase):
    def test_german_y_and_z_are_not_swapped(self):
        self.assertEqual(module.german_keys('yYzZ'),[(29,False),(29,True),(28,False),(28,True)])
    def test_german_umlauts_and_eszett(self):
        self.assertEqual(module.german_keys('äÄöÖüÜß'),[(52,False),(52,True),(51,False),(51,True),(47,False),(47,True),(45,False)])
    def test_unsupported_suffix_rejects_entire_text_before_event_generation(self):
        with self.assertRaises(module.UnsupportedText):module.german_keys('valid prefix 😀')
    def test_punctuation_uses_german_keys(self):
        self.assertEqual(module.german_keys('-_?'),[(56,False),(56,True),(45,True)])
    def test_option_symbols_use_verified_german_apple_key_positions(self):
        self.assertEqual(module.german_keys('@€\\<>'),[(15,2),(8,2),(36,3),(53,False),(53,True)])
    def test_keyboard_is_read_from_selected_simulator_only(self):
        with tempfile.TemporaryDirectory() as home:
            root=Path(home)/'Library/Developer/CoreSimulator/Devices'
            for udid,layout in [('selected','de_DE@sw=QWERTZ-German;hw=Automatic'),('other','en_US@sw=QWERTY;hw=Automatic')]:
                path=root/udid/'data/Library/Preferences/com.apple.keyboard.preferences.plist'
                path.parent.mkdir(parents=True);path.write_bytes(plistlib.dumps({'KeyboardsCurrentAndNext':[layout,layout]}))
            self.assertEqual(module.keyboard_layout('selected',home),'de-DE')
            self.assertEqual(module.keyboard_layout('other',home),'en-US')
    def test_unknown_layout_never_falls_back_to_us(self):
        with tempfile.TemporaryDirectory() as home:
            path=Path(home)/'Library/Developer/CoreSimulator/Devices/selected/data/Library/Preferences/com.apple.keyboard.preferences.plist'
            path.parent.mkdir(parents=True);path.write_bytes(plistlib.dumps({'KeyboardsCurrentAndNext':['fr_FR@sw=AZERTY;hw=Automatic']}))
            with self.assertRaises(module.UnsupportedText):module.keyboard_layout('selected',home)
if __name__=='__main__':unittest.main()
