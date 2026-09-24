#!/usr/bin/env bash
set -euo pipefail
R=/home/bluecake/ai/pi-toolkit
SNAP=/tmp/exp5-repo; P=/tmp/.p5x
rm -rf $SNAP $P && mkdir -p $SNAP $P
# 1. 快照：文档提交之前的代码，无 .git（没有历史可翻）
git -C $R archive 14e28c0 | tar -x -C $SNAP
[ -e $SNAP/docs/dev/fabric-v2 ] && { echo "LEAK: fabric-v2 in snapshot"; exit 1; }
diff -rq $R/src $SNAP/src && echo "snapshot src identical to HEAD"
# 2. 专家的知识源（只有专家被指示去读）
cp $R/docs/dev/fabric-v2/plan.md $P/plan.md
cat > $P/brief-A.md <<'EOF'
# 任务：评审 fabric v2 方案的最终设计，列出实施风险

`/tmp/.p5x/plan.md` 是 pi-toolkit「fabric v2（inter-agent 消息织网）」的设计方案，经历过两轮评审，文末 §15 是评审后的处置与修订（其中有些决定推翻了正文里的早期设计）。
`/tmp/exp5-repo/src/fabric/` 是现有 v1 实现。

请：
1. **完整读完** plan.md 全文（read 工具每次最多约 50KB，需要分段读，不要跳过任何部分）；
2. 阅读 `/tmp/exp5-repo/src/fabric/` 下的现有实现；
3. 对照最终设计与现有代码，列出实施时风险最大的 5 点。

不要写任何文件。最终回复只给这 5 点风险（每点一行）。
EOF
# 3. 临时类型
A=~/.pi/agent/agents
cat > $A/upstream-analyst.md <<'EOF'
---
name: upstream-analyst
display_name: 上游分析师
description: 资深架构分析师，负责阅读设计文档与代码、评审方案并识别风险。
tools: read, grep, find, ls, bash
prompt_mode: replace
---

你是一名资深架构分析师。你的工作是阅读设计文档与代码、评审方案、识别风险，并清晰准确地回答关于你读过的内容的问题。
回答他人的问题时：以你读过的材料的**最终结论**为准（后面的修订优先于前面的早期设计）；不确定的就明确说不确定。
EOF
sed -e 's/^name: architect$/name: architect-consult/' -e '/^tools:/a can_spawn: upstream-analyst' $A/architect.md > $A/architect-consult.md
diff <(sed 1,12d $A/architect.md) <(sed 1,13d $A/architect-consult.md) && echo "architect-consult body identical"
# 4. 下游任务：基于实验 4 的 C1 任务文件，只改仓库路径、请教方式与信息来源限制
python3 - "$R/docs/dev/fabric-v2/exp3/task-c1.md" "$P/task-e1.md" <<'PY'
import sys,io
s=io.open(sys.argv[1],encoding="utf-8").read()
s=s.replace("/home/bluecake/ai/pi-toolkit","/tmp/exp5-repo")
old_ask=s[s.index("## 可以请教前序阶段的参与者"):s.index("## 方案必须覆盖")]
new_ask='''## 可以请教前序阶段的参与者

前序阶段的参与者（label：`upstream-expert`）读过完整的设计讨论与评审记录，现已结束工作，但可以被唤醒请教。需要时可以随时请教：调用 `Agent` 工具，`subagent_type: "upstream-analyst"`，`resume: "upstream-expert"`，`description` 随意，`prompt` 写你的问题（可以一次问多个）。它会在**当轮直接返回答案**，不会打断你的工作。

'''
s=s.replace(old_ask,new_ask)
ban='''## 信息来源限制

只允许读取 `/tmp/exp5-repo` 内的文件与你自己的任务目录。**不要**搜索或读取任何其它位置。

'''
assert s.count("## 输出")==1
s=s.replace("## 输出", ban+"## 输出",1)
io.open(sys.argv[2],"w",encoding="utf-8").write(s)
PY
: > $P/exp5-armmap.tsv
for arm in e1-r1 e1-r2 e1-r3; do
  d=/tmp/w$(echo -n "exp5-$arm-salt41" | sha1sum | cut -c1-10); rm -rf $d; mkdir -p $d
  cp $P/task-e1.md $d/task.md
  printf "%s\te1\t%s\n" "$arm" "$d" >> $P/exp5-armmap.tsv
done
cat $P/exp5-armmap.tsv
grep -c "upstream-expert" $P/task-e1.md
