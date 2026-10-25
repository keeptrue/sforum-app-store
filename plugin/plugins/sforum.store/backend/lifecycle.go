package main

import (
	"context"
	"fmt"
	"strings"

	pluginv2 "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2"
	protocolwire "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
)

// runLifecycle 承接 install/enable/disable/upgrade/rollback/uninstall 的
// plan/execute 步骤。
//
// 商城插件没有需要迁移的持久状态：目录缓存在进程内存里，商城地址与频道存在宿主
// 的 extension_settings（随版本保留），签名链接从不落盘。因此每个步骤都是幂等
// no-op，只按宿主生命周期机允许的状态序列回报 PLANNED → RUNNING → SUCCEEDED。
//
// 声明 lifecycle 不是为了这些空步骤本身，而是为了让宿主走 V2 生命周期：只有 V2
// 包在换摘要时会被生命周期协调器重新发布注册表（路由/查询/组件），否则路由会带着
// 上一个运行时实例的身份留在注册表里、永远无法准入（表现为 extension.runtime_unavailable）。
func runLifecycle(
	ctx context.Context,
	request *protocolwire.LifecycleRequest,
	progress *pluginv2.ProgressStream,
) error {
	if request == nil || progress == nil {
		return fmt.Errorf("missing lifecycle request")
	}
	stepID := strings.TrimSpace(request.GetStepId())
	if stepID == "" {
		stepID = lifecycleStepID(request.GetAction(), request.GetDryRun())
	}
	checkpoint := "plan"
	if !request.GetDryRun() {
		checkpoint = "execute"
	}

	if err := progress.Send(&protocolwire.ProgressUpdate{
		StepId: stepID, State: protocolwire.ProgressState_PROGRESS_STATE_PLANNED,
		CompletedUnits: 0, TotalUnits: 3, Checkpoint: checkpoint + ".start",
	}); err != nil {
		return err
	}
	if err := progress.Send(&protocolwire.ProgressUpdate{
		StepId: stepID, State: protocolwire.ProgressState_PROGRESS_STATE_RUNNING,
		CompletedUnits: 1, TotalUnits: 3, Checkpoint: checkpoint + ".running",
	}); err != nil {
		return err
	}
	if err := progress.Send(&protocolwire.ProgressUpdate{
		StepId: stepID, State: protocolwire.ProgressState_PROGRESS_STATE_RUNNING,
		CompletedUnits: 2, TotalUnits: 3, Checkpoint: checkpoint + ".external",
	}); err != nil {
		return err
	}
	// 长步骤也响应取消：宿主 abort 时不要让流停在 running。
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	default:
	}
	return progress.Send(&protocolwire.ProgressUpdate{
		StepId: stepID, State: protocolwire.ProgressState_PROGRESS_STATE_SUCCEEDED,
		CompletedUnits: 3, TotalUnits: 3, Checkpoint: checkpoint + ".done",
	})
}

func lifecycleActionName(action protocolwire.LifecycleAction) string {
	switch action {
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_INSTALL_PLAN:
		return "install.plan"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_INSTALL:
		return "install.execute"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_ENABLE:
		return "enable.execute"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_DISABLE:
		return "disable.execute"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_UPGRADE_PLAN:
		return "upgrade.plan"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_UPGRADE_BEFORE:
		return "upgrade.before"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_UPGRADE_AFTER:
		return "upgrade.after"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_ROLLBACK:
		return "rollback.execute"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_UNINSTALL_PLAN:
		return "uninstall.plan"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_UNINSTALL:
		return "uninstall.execute"
	case protocolwire.LifecycleAction_LIFECYCLE_ACTION_UNINSTALL_AFTER:
		return "uninstall.after"
	default:
		return "unknown"
	}
}

func lifecycleStepID(action protocolwire.LifecycleAction, dryRun bool) string {
	name := lifecycleActionName(action)
	if dryRun && !strings.HasSuffix(name, ".plan") {
		return name + ".plan"
	}
	return name
}
