
## 版本号规则（MMP：主版本.次版本.修订号）

用户要求（原话）："XYZ/MMP方式命名版本号" → 已确认为「按语义升位：有功能升次版本、只修 bug 升修订号」。

**规则**

1. **一个版本号只对应一个待发布版本。** 预发布是同一个号下的形态，写成 `X.Y.Z-pre`、`X.Y.Z-pre.2`……
   不再"每个预发布都往上加一个修订号" —— 之前 `2.3.4-pre` 一路涨到 `2.3.21-pre`，
   把新功能和修 bug 全塞进修订号里，那是错的。
2. **升哪一位看改动性质：**
   | 改动 | 升位 | 例 |
   | --- | --- | --- |
   | 有新功能 | 次版本 minor | 2.3.19 → 2.4.0 |
   | 只修 bug / 只改工具 | 修订号 patch | 2.3.19 → 2.3.20 |
   | 有不兼容改动 | 主版本 major | 2.3.19 → 3.0.0 |
3. **预发布转正式版号不变**，只去掉 `-pre`（2.3.22-pre → 2.3.22）。
4. **版本号必须严格单调递增**：新号一定要大于所有已发布的 tag。
   已发布的 tag **永不重打** —— 重打会让已装用户的版本号对不上。

**这个判断不再靠人记**，全部交给脚本（规则实现在 `scripts/version-lib.js` 一处）：

```
node scripts/bump-version.js --patch          # 只修 bug
node scripts/bump-version.js --minor          # 有新功能
node scripts/bump-version.js --major          # 有不兼容
node scripts/bump-version.js --patch --pre     # 上面任一个加 --pre = 出该版本的预发布
node scripts/bump-version.js --pre-next       # 同一版本的第二个预发布（-pre → -pre.2）
node scripts/bump-version.js --promote        # 预发布转正式版（号不变）
```

脚本会**自动拒绝**回退的号：

```
$ node scripts/bump-version.js 2.3.21-pre
版本号没有递增：2.3.21-pre 不大于已发布的 tag：2.3.21-pre
已发布的 tag 永不重打（重打会让已装用户的版本号对不上）。请换一个更大的号。
```

**两处必须一致**（各有测试盯着）：

- `scripts/version-lib.js` 的比较语义 ⇄ `renderer/app.js` 的 `compareVersions`
  （两处对"哪个版本更新"必须给出同一答案）
- 预发布判定 ⇄ 工作流里的 `prerelease: contains(v, '-')`
  （不一致就会把预发布当成正式版推给正式用户）

> 教训（这个项目反复踩）：**同一个事实写在两处一定会漂移**。
> 版本号这件事以前就是"靠人记"，于是出现了 package-lock 漂了两版、tag 没跟着动、
> 每个预发布都加修订号这些问题。现在规则只有一处实现，其余都是断言。
