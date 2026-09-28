{
  description = "Relay — web-based VNC + low-latency H.264 streaming client";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    # nixpkgs-unstable has dropped x86_64-darwin, so list systems explicitly.
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
    eachSystem = f:
      nixpkgs.lib.genAttrs systems (
        system: f nixpkgs.legacyPackages.${system}
      );
  in {
    formatter = eachSystem (pkgs: pkgs.biome);

    devShells = eachSystem (pkgs: {
      default = pkgs.mkShell {
        packages =
          [
            pkgs.nodejs_22
            pkgs.biome
            pkgs.ffmpeg # regenerate the e2e H.264 fixture
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.chromium
            pkgs.x11vnc
            pkgs.xorg.xvfb
            pkgs.playwright-driver.browsers
          ];
        # On Linux/CI, use the nix-provided Playwright browsers — keep the npm
        # `playwright` version aligned with pkgs.playwright-driver. On macOS, run
        # `npx playwright install` instead (Chromium isn't pinned here).
        shellHook = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
          export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
          export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
        '';
      };
    });

    # `nix run .#e2e-real` (Linux only): run the VNC e2e against a real
    # x11vnc + Xvfb server instead of the in-process mock.
    apps = eachSystem (pkgs:
      pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        e2e-real = {
          type = "app";
          program = pkgs.lib.getExe (pkgs.writeShellApplication {
            name = "relay-e2e-real";
            runtimeInputs = [
              pkgs.nodejs_22
              pkgs.x11vnc
              pkgs.xorg.xvfb
              pkgs.chromium
              pkgs.playwright-driver.browsers
            ];
            text = ''
              export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              export DISPLAY=:99
              Xvfb :99 -screen 0 1280x800x24 &
              XVFB_PID=$!
              sleep 1
              PORT=5999
              x11vnc -display :99 -rfbport "$PORT" -nopw -forever -shared -quiet &
              X11VNC_PID=$!
              sleep 1
              export RELAY_E2E_VNC_HOST=127.0.0.1
              export RELAY_E2E_VNC_PORT="$PORT"
              export CI=1
              cleanup() { kill "$X11VNC_PID" "$XVFB_PID" 2>/dev/null || true; }
              trap cleanup EXIT
              npm ci
              npx playwright test tests/dashboard.e2e.ts tests/vnc-session.e2e.ts
            '';
          });
        };
      });
  };
}
