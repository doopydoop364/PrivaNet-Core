import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('updater', str(Path(__file__).parents[1] / 'deploy/bin/privanet-update'))
spec = importlib.util.spec_from_loader(loader.name, loader)
u = importlib.util.module_from_spec(spec)
loader.exec_module(u)

class UpdaterTests(unittest.TestCase):
    def test_channels_numeric_prereleases_no_downgrades_and_series_boundary(self):
        releases = [{'tag_name': tag, 'prerelease': '-' in tag} for tag in ['v0.4.0-alpha.3.1', 'v0.4.0-alpha.4', 'v0.4.0-alpha.10', 'v0.5.0', 'v0.4.0']]
        self.assertEqual(u.select_release(releases, '0.4.0-alpha.3.1', 'stable')['tag_name'], 'v0.4.0')
        self.assertEqual(u.select_release(releases[:-1], '0.4.0-alpha.3.1', 'prerelease')['tag_name'], 'v0.4.0-alpha.10')
        self.assertIsNone(u.select_release(releases, '0.4.0', 'prerelease'))
        self.assertIsNone(u.select_release([{'tag_name': 'v0.4.1', 'draft': True}], '0.4.0', 'stable'))

    def test_https_redirect_allowlist_and_no_credentials(self):
        for url in ['http://github.com/a', 'https://github.com.evil/a', 'https://user:pass@github.com/a', 'https://github.com:444/a', 'https://127.0.0.1/a']:
            with self.assertRaises(u.UpdateError):
                u.allowed_url(url)
        u.allowed_url('https://release-assets.githubusercontent.com/a')

    def archive(self, root, name, data=b'hello', link=False):
        path = root / 'release.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            member = tarfile.TarInfo(name)
            if link:
                member.type = tarfile.SYMTYPE
                member.linkname = '/etc/passwd'
                archive.addfile(member)
            else:
                member.size = len(data)
                member.mode = 0o4755
                archive.addfile(member, io.BytesIO(data))
        return path

    def test_archive_traversal_links_and_wrong_root_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, link in [('app/../../outside', False), ('/outside', False), ('wrong/file', False), ('app/link', True), ('app\\file', False)]:
                archive = self.archive(root, name, link=link)
                with self.assertRaises(u.UpdateError):
                    u.extract_release(archive, root / 'out', 'app')
            archive = self.archive(root, 'app/run')
            output = u.extract_release(archive, root / 'out', 'app')
            self.assertEqual((output / 'run').read_bytes(), b'hello')
            self.assertEqual((output / 'run').stat().st_mode & 0o7777, 0o755)

    def test_program_permissions_under_private_service_umask(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            previous = os.umask(0o077)
            try:
                archive = self.archive(root, 'app/bin/run')
                program = u.extract_release(archive, root / 'out', 'app')
                (program / 'node_modules/dependency').mkdir(parents=True)
                (program / 'node_modules/dependency/index.js').write_text('module')
                u.program_permissions(program)
                for path in [program, program / 'bin', program / 'node_modules/dependency']:
                    self.assertEqual(path.stat().st_mode & 0o777, 0o755)
                self.assertEqual((program / 'node_modules/dependency/index.js').stat().st_mode & 0o777, 0o644)
                self.assertEqual((program / 'bin/run').stat().st_mode & 0o7777, 0o755)
                (program / 'outside').symlink_to('/etc')
                with self.assertRaises(u.UpdateError):
                    u.program_permissions(program)
            finally:
                os.umask(previous)

    def test_existing_core_archive_version_without_root_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest = root / 'node_modules/@privanet/protocol/package.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"version":"0.4.0-alpha.3.1"}')
            self.assertEqual(u.installed_version(root, 'core'), '0.4.0-alpha.3.1')
            (root / 'package.json').write_text('{"version":"0.4.0-alpha.4"}')
            self.assertEqual(u.installed_version(root, 'core'), '0.4.0-alpha.4')

    def test_application_release_layouts_use_kind_specific_entrypoints(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            proxy = root / 'proxy'
            (proxy / 'bin').mkdir(parents=True)
            (proxy / 'package-lock.json').write_text('{}')
            (proxy / 'bin/privaproxy.js').write_text('program')
            u.validate_release_layout(proxy, 'proxy')
            (proxy / 'bin/privaproxy.js').unlink()
            with self.assertRaises(u.UpdateError):
                u.validate_release_layout(proxy, 'proxy')

            search = root / 'search'
            (search / 'dist').mkdir(parents=True)
            (search / 'package-lock.json').write_text('{}')
            (search / 'dist/main.js').write_text('program')
            u.validate_release_layout(search, 'search')

    def test_hash_mismatch_and_ambiguous_manifest_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'archive'
            path.write_bytes(b'release')
            good = (hashlib.sha256(b'release').hexdigest() + '  archive\n').encode()
            u.verify_checksum(good, 'archive', path)
            for bad in [good + good, b'0' * 64 + b'  archive\n', good.replace(b'archive', b'other')]:
                with self.assertRaises(u.UpdateError):
                    u.verify_checksum(bad, 'archive', path)

    def test_backup_private_keeps_identity_and_never_changes_live_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / 'state'
            state.mkdir()
            (state / 'identity.json').write_text('private-existing-identity')
            link = root / 'current'
            link.symlink_to(state)
            target = root / 'backup'
            u.backup({'kind': 'core', 'link': str(link), 'backupPaths': [str(state)]}, target)
            self.assertEqual((target / 'state-and-config.tar.gz').stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertEqual((state / 'identity.json').read_text(), 'private-existing-identity')
            with tarfile.open(target / 'state-and-config.tar.gz') as archive:
                self.assertTrue(any(m.name.endswith('identity.json') for m in archive))

    def test_backup_respects_owner_storage_reserve(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'policy.json').write_text(json.dumps({'policy': {'storage': {'reserveFreeBytes': 100 * 1024 ** 3}}}))
            app = {'kind': 'core', 'backupPaths': [str(root)], 'link': str(root)}
            self.assertEqual(u.reserve_margin(app), 100 * 1024 ** 3)
            with patch.object(u.shutil, 'disk_usage', return_value=type('Space', (), {'free': 10 * 1024 ** 3})()):
                with self.assertRaises(u.UpdateError):
                    u.backup(app, root / 'backup')
            self.assertFalse((root / 'backup').exists())

    def test_atomic_link_preserves_old_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, new = root / 'old', root / 'new'
            old.mkdir(); new.mkdir()
            (old / 'identity').write_text('retain')
            link = root / 'current'
            link.symlink_to(old)
            u.atomic_link(link, new)
            self.assertEqual(link.resolve(), new)
            self.assertTrue((old / 'identity').exists())
            u.atomic_link(link, old)
            self.assertEqual(link.resolve(), old)

    def test_update_failure_rolls_back_program_without_restoring_security_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / 'old'
            old.mkdir()
            (old / 'package.json').write_text('{"version":"0.4.0-alpha.3.1"}')
            link = root / 'current'
            link.symlink_to(old)
            backups = root / 'backups'
            backups.mkdir()
            state = root / 'state'
            state.mkdir()
            (state / 'replay').write_text('newer-replay')
            app = {'id': 'node', 'kind': 'core', 'link': str(link), 'services': ['privanet-node.service'], 'backupPaths': [str(state)]}
            release = {'tag_name': 'v0.4.0-alpha.4', 'assets': [{'name': n} for n in ['privanet-0.4.0-alpha.4-linux.tar.gz', 'SHA256SUMS.txt']]}
            def extract(_archive, target, expected):
                staged = target / expected
                (staged / 'bin').mkdir(parents=True)
                (staged / 'package.json').write_text('{"version":"0.4.0-alpha.4"}')
                for name in ['privanet-coordinator', 'privanet-node']:
                    (staged / 'bin' / name).write_text('program')
                return staged
            with patch.object(u, 'download'), patch.object(u, 'verify_checksum'), patch.object(u, 'extract_release', side_effect=extract), patch.object(u, 'run'), patch.object(u.time, 'sleep'), patch.object(u, 'active', side_effect=[True, False]), patch.object(u, 'emit') as output:
                with self.assertRaises(u.UpdateError):
                    u.apply_update(app, release, backups)
                self.assertEqual(link.resolve(), old)
                self.assertEqual((state / 'replay').read_text(), 'newer-replay')
                self.assertTrue(any(call.args[1] == 'PROGRAM_ROLLED_BACK' for call in output.call_args_list))

if __name__ == '__main__':
    unittest.main()
