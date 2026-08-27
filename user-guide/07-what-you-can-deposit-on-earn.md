---
description: 比较可以存入 Earn 的各种资产
---

# Earn 页面支持哪些存入资产

前面的指南介绍了 [GREEN LP 代币](05-provide-liquidity.md)和 [RIPE](06-get-and-lock-ripe.md)。这里列出完整清单，因为四类 Earn 资产的操作方式相同。具体交易对和交易场所取决于所在网络；下表采用截图中的示例。

| Earn 资产 | 它是什么 | 在哪里获取 |
| --- | --- | --- |
| **sGREEN** | [Savings GREEN](../earning-and-rewards/01-sgreen.md)：其 GREEN 价值会随协议收入增长 | 借款时将 Receive Token 设为 Savings GREEN，或使用 **Get sGREEN** 兑换 |
| **GREEN LP**（本例为 GREEN/USDG） | 您在 GREEN 稳定币资金池中的份额 | 通过 **Get GREEN** 直接兑换，或使用 **Get GREEN/USDG LP** 在 Curve 上添加两侧资产（参见[获取 GREEN 并提供流动性](05-provide-liquidity.md)） |
| **RIPE** | 协议的治理代币 | 使用 **Get RIPE**，或通过 **Bridge RIPE** 从其他网络转入（参见[获取并锁定 RIPE](06-get-and-lock-ripe.md)） |
| **RIPE LP**（本例为 RIPE/WETH） | 您在 RIPE 资金池中的份额 | 使用 **Get RIPE/WETH LP**，该链接会跳转至 Uniswap V2 |

四类资产的流程都一样：先通过相应的 **Get** 链接获取代币，再将其存入 Ripe。Get 链接始终指向正确场所，因此您无需自行辨认资金池。不要自己到处寻找这些池。

底层可以分为两类。RIPE 和 RIPE LP 进入治理金库，重点是锁定和积分；sGREEN 和 GREEN LP 进入[稳定池](../earning-and-rewards/02-stability-pools.md)，重点是以低于市场价格买入被清算的抵押品。

**如何理解收益率。** 每种资产会叠放显示两个数字：上方是 **APY**，下方是 **+ [某个数值]% Locked RIPE Rewards**。二者含义不同，但很容易被误读为同一个数字。

上方数字是资产本身的收益率；下方数字是额外以 RIPE 支付的奖励。之所以标记为 locked（锁定），原因见[获取并锁定 RIPE](06-get-and-lock-ripe.md#领取奖励时如何应用锁定)：您领取的大部分 RIPE 会被质押，而不是发送到钱包。上方数字代表可以实际动用的收益，下方数字则代表需要等待解锁的价值。

两者都是估算值。在资金池规模较小时，两者通常都较高；随着存款增加，两者都会下降。

---

_本文未涵盖：执行[清算](../core-protocol/04-liquidations.md)（Liquidations 页面面向运行清算的高级用户；[借入 GREEN](03-borrow-green.md)介绍如何避免成为被清算方）、[债券](../governance-and-economics/03-bonds.md)和 [RIPE Reserve Engine](../governance-and-economics/04-reserve-engine.md)——这些内容请参阅相应协议指南。_
