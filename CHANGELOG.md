# Changelog

## [0.5.2](https://github.com/AbdallahAHO/jevway/compare/v0.5.1...v0.5.2) (2026-11-02)


### Bug Fixes

* **journeys:** report controls named only by their surroundings as unlabeled ([f99b8dc](https://github.com/AbdallahAHO/jevway/commit/f99b8dc324e740baab6f5fb31815f7302e6f5b2a))

## [0.5.1](https://github.com/AbdallahAHO/jevway/compare/v0.5.0...v0.5.1) (2026-11-02)


### Bug Fixes

* **cli:** never quote a json flag's input in its error ([309356a](https://github.com/AbdallahAHO/jevway/commit/309356a8f1180d6554fec8d991ba4dda3a3c1623))

## [0.5.0](https://github.com/AbdallahAHO/jevway/compare/v0.4.0...v0.5.0) (2026-11-02)


### Features

* add jevway mcp, the MCP server on stdio from the main bin ([e845b78](https://github.com/AbdallahAHO/jevway/commit/e845b786a7ff5643aef1ebbd7847812e4821df15))

## [0.4.0](https://github.com/AbdallahAHO/jevway/compare/v0.3.0...v0.4.0) (2026-11-02)


### Features

* read and type verification codes split into boxes ([166a8ff](https://github.com/AbdallahAHO/jevway/commit/166a8ff9e0cf386fd82f6f612e650989f48a603c))


### Bug Fixes

* mask split code boxes only in the document they were typed in ([d2afc1c](https://github.com/AbdallahAHO/jevway/commit/d2afc1c601e1508e5e588499c8097f5c53692802))

## [0.3.0](https://github.com/AbdallahAHO/jevway/compare/v0.2.0...v0.3.0) (2026-11-02)


### Features

* add desktop notifications for a person to act ([915e452](https://github.com/AbdallahAHO/jevway/commit/915e45206780abdb33b1ab3e1e3e07a5247160a8))
* add jevway inbox through the daemon or an env file ([d05e5a6](https://github.com/AbdallahAHO/jevway/commit/d05e5a61bf0c44a6aec720ea40f203628f03127c))
* add the disposable inbox client ([a2572cf](https://github.com/AbdallahAHO/jevway/commit/a2572cf9c215c869175b5419cfa03c9009b4bd7e))
* add the jevway_inbox_create and jevway_inbox_wait tools ([d96213e](https://github.com/AbdallahAHO/jevway/commit/d96213e2591752f49c3ddb628988e6ff500e32bd))
* bundle the jevway-inbox skill and install it with jevway's ([0231a53](https://github.com/AbdallahAHO/jevway/commit/0231a53d100c2d147d9b94adb37fc918b7830b76))
* carry a ready-made ask_user question on hand-backs ([066985f](https://github.com/AbdallahAHO/jevway/commit/066985f5290bb856a9c44d05983adfe6ccbc2600))
* downloads, https and frame uploads, drop zones and look pdfs ([70b5e2a](https://github.com/AbdallahAHO/jevway/commit/70b5e2ad2908dc64512e961e7a002b0ce0973515))
* type authenticator codes computed at typing time ([158eba6](https://github.com/AbdallahAHO/jevway/commit/158eba6e3a04bc43bcf27d3ef1f744df7f66f5c4))
* wait for a person at a bot check, sign-in or sso page ([645a96e](https://github.com/AbdallahAHO/jevway/commit/645a96e9e6c6f0112617d0fa43459bfaf851b747))


### Bug Fixes

* ask to rerun with a session when a one-shot run hits a wall ([0399e86](https://github.com/AbdallahAHO/jevway/commit/0399e86562bd901549dfb53197e98d5481936c66))
* check ip literal url uploads and refuse redirects with credentials ([754e877](https://github.com/AbdallahAHO/jevway/commit/754e877a3e4c9688333bb88a42e4e4260adcc48a))
* keep a malformed --totp out of its usage error ([e6b29e4](https://github.com/AbdallahAHO/jevway/commit/e6b29e45c1b0936e2078a0d88d776a254183a8e9))
* word wall questions for headless browsers and finished waits ([859822b](https://github.com/AbdallahAHO/jevway/commit/859822b2ab714c26c00b34af7d986a51808bbf88))

## [0.2.0](https://github.com/AbdallahAHO/jevway/compare/v0.1.2...v0.2.0) (2026-11-02)


### Features

* add jevway doctor --json ([206d73e](https://github.com/AbdallahAHO/jevway/commit/206d73e64816dab38146e7e657a7de68302c789e))
* add jevway setup --client --print ([7fd6cd0](https://github.com/AbdallahAHO/jevway/commit/7fd6cd0f1925ef104c0be44ae4a8379fa1326ee4))
* add jevway skill and skill --install ([3f739b6](https://github.com/AbdallahAHO/jevway/commit/3f739b6dc9e691834f2436a41caa504d817d0264))
* add the interactive jevway setup ([34c0e19](https://github.com/AbdallahAHO/jevway/commit/34c0e19bfbfd52b425a73c275ed3798a6e960269))
* add the output layout, slugs and manifests ([b211d9b](https://github.com/AbdallahAHO/jevway/commit/b211d9bd73ac244082d97579c94c2137c8c1d473))
* add the transport-free session service ([ec37247](https://github.com/AbdallahAHO/jevway/commit/ec372473735ff0421b080909a26ee98221a1f2c2))
* give a task a run folder with its end page and named step shots ([5275e5d](https://github.com/AbdallahAHO/jevway/commit/5275e5df85146bb6b3c0ad82166f3f3d0593213f))
* make run and journey pages readable for people and agents ([13a7319](https://github.com/AbdallahAHO/jevway/commit/13a7319aefe0f4e1c8569367b724a81249618b74))
* name journey screens by type and list a journey's files ([045d92c](https://github.com/AbdallahAHO/jevway/commit/045d92cdfa362b3e7b8aa09cc161aac305f0da3e))
* run cli sessions through an auto-started daemon ([1e3809e](https://github.com/AbdallahAHO/jevway/commit/1e3809eeb3d8750e2b95e5dc528b500f373180d3))
* serve mcp tools from the session service with links, images and progress ([9a4bcd5](https://github.com/AbdallahAHO/jevway/commit/9a4bcd5e72825fbc9ceb75f2f390e740fa76ddaf))
* tell each step as a sentence and present concise summaries ([f95441d](https://github.com/AbdallahAHO/jevway/commit/f95441de4264a1c469176817f09afbd1f927ef88))


### Bug Fixes

* accept keys that contain = in jevway setup ([7e6458f](https://github.com/AbdallahAHO/jevway/commit/7e6458f1b1c6fcea39b19065091268b07c74ef0c))
* apply the server's host lists to jevway_look and journeys ([c46e8ba](https://github.com/AbdallahAHO/jevway/commit/c46e8badd27df2f4a6c5c814770ddc92e90c8c24))
* drop the old done_when when a session gets a new goal ([39ba200](https://github.com/AbdallahAHO/jevway/commit/39ba200f76c87fa028f4b5330cf459013023fbaf))
* fall back to a short daemon socket path when the state dir is deep ([c24d86d](https://github.com/AbdallahAHO/jevway/commit/c24d86d69e10a4d1b979951828927ec2303448af))
* keep a summary in the run folder when the recording fails ([93e1505](https://github.com/AbdallahAHO/jevway/commit/93e1505caa37a94c4a7858ddc94ede136ca59b69))
* keep printed headings with the section they open ([d910b69](https://github.com/AbdallahAHO/jevway/commit/d910b694e016c413c6e9bbbd50b1212c5fe488b3))
* keep the daemon log one json object per line ([6c2ed3b](https://github.com/AbdallahAHO/jevway/commit/6c2ed3bf696f508bd414446698439d175372f663))
* mask secret values in jevway_look on a session ([5f0adb1](https://github.com/AbdallahAHO/jevway/commit/5f0adb1fcd375b16872c6665557638506401ead5))
* print removed lines first in the setup diff ([ea871de](https://github.com/AbdallahAHO/jevway/commit/ea871de0aeea79a34a6d71fb925d8ca6605d7bf1))
* read concise results in the verify and agent reports ([33a67ff](https://github.com/AbdallahAHO/jevway/commit/33a67ffba0487e1a9af743ffbda3f5605623fad5))
* read the json block of a relayed result in the agent suite ([1e4e04f](https://github.com/AbdallahAHO/jevway/commit/1e4e04f79564ee01cb0ebc7a5c12bad05ebc2634))
* require JEVWAY_REPLAY_DIR instead of writing into verify/out ([b1941a8](https://github.com/AbdallahAHO/jevway/commit/b1941a8c96a7cdfac8bff2089bcb7b5987f02a10))
* retry journey model calls when the api is busy ([a379551](https://github.com/AbdallahAHO/jevway/commit/a379551f0bb97a9ad8f4b105710d89f95554928d))
* share one result order between mcp and cli ([2b26ebf](https://github.com/AbdallahAHO/jevway/commit/2b26ebf2db138161e7932d72ca5ccbfc9d097fe0))
* start doctor, setup and skill help with examples ([4be4a3f](https://github.com/AbdallahAHO/jevway/commit/4be4a3f6f73a83a0791b3ba4962a7e9a4338a8f9))
* tell the agent report's step captions as the story ([70dfd87](https://github.com/AbdallahAHO/jevway/commit/70dfd876e65ef2d08d37ea7f56a93a734b522f27))

## [0.1.2](https://github.com/AbdallahAHO/jevway/compare/v0.1.1...v0.1.2) (2026-11-02)


### Bug Fixes

* report the package version from the mcp server ([dc964ff](https://github.com/AbdallahAHO/jevway/commit/dc964ff76064efea70e0674a68753ed3df29d065))

## [0.1.1](https://github.com/AbdallahAHO/jevway/compare/v0.1.0...v0.1.1) (2026-11-02)


### Miscellaneous Chores

* release 0.1.1 ([a4f45cc](https://github.com/AbdallahAHO/jevway/commit/a4f45cc8e2b7bbe9a379de32618adf64f064e9dc))
