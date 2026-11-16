"""Focused unit checks for the visual gate measurements, without an EGL context."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from PIL import Image

spec = importlib.util.spec_from_file_location('shader_qa', Path(__file__).with_name('shader_qa.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)

class MeasurementTests(unittest.TestCase):
    def test_blank_static_and_changing_frames_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory)/f'{i}.png' for i in range(4)]
            for path in paths:
                Image.new('RGB', (32, 32)).save(path)
            blank, _ = qa.measurements(paths)
            self.assertEqual(blank['min_coverage'], 0)
            self.assertEqual(blank['mean_temporal_delta'], 0)
            for i, path in enumerate(paths):
                im = Image.new('RGB', (32, 32))
                for x in range(i*4, i*4+8):
                    for y in range(32):
                        im.putpixel((x, y), (255, 255, 255))
                im.save(path)
            motion, _ = qa.measurements(paths)
            self.assertEqual(motion['min_coverage'], 0.25)
            self.assertGreater(motion['min_contrast'], 20)
            self.assertGreater(motion['mean_temporal_delta'], 20)

    def test_shader_contracts_detect_wrong_changes(self):
        dark = Image.new('RGB', (16, 16), (32, 32, 32))
        same = dark.copy()
        changed = dark.copy(); changed.putpixel((2, 2), (255, 255, 255))
        self.assertTrue(qa.compare_pair('circuit', [dark], [same])['passed'])
        self.assertFalse(qa.compare_pair('circuit', [dark], [changed])['passed'])
        self.assertFalse(qa.compare_pair('fibonacci', [dark], [changed])['passed'])
        black = Image.new('RGB', (16, 16))
        self.assertTrue(qa.compare_pair('mobius', [black], [dark])['passed'])
        self.assertFalse(qa.compare_pair('mobius', [dark], [black])['passed'])

if __name__ == '__main__':
    unittest.main()
