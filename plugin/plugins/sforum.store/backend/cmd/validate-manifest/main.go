// validate-manifest 用 SForum 自己的包加载器与 MV3 校验器检查清单，
// 避免「看起来对」的清单只在我们自己眼里成立。
//
//	cd backend && go run ./cmd/validate-manifest ..
//
// 参数是扩展包根目录（含 sforum.extension.json 的那一层）。
package main

import (
	"fmt"
	"os"

	extensionmanifest "github.com/keeptrue/sforum/apps/api/app/Support/ExtensionManifest"
)

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}

	body, err := os.ReadFile(root + "/sforum.extension.json")
	if err != nil {
		fail("read manifest: %v", err)
	}
	if err := extensionmanifest.ValidateV3JSONSchema(body); err != nil {
		fail("json schema: %v", err)
	}

	manifest, err := extensionmanifest.LoadPackage(root)
	if err != nil {
		fail("load package: %v\n%+v", err, err)
	}
	if err := extensionmanifest.Validate(manifest); err != nil {
		fail("semantic validation: %v", err)
	}

	fmt.Printf("manifest OK: %s %s (%s), %d routes, %d admin pages\n",
		manifest.ID, manifest.Version, manifest.Type, len(manifest.Routes), len(manifest.Admin.Pages))
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "manifest INVALID: "+format+"\n", args...)
	os.Exit(1)
}
