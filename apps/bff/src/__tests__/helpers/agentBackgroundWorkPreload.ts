import { beforeEach } from 'bun:test'
import { settleAgentTailsForTesting } from '../../lib/agent/background-work'

/**
 * 每个用例开始前（先于测试文件自己的 beforeEach 清库）把上一个用例留下的工作收干净：还在跑的轮
 * 中止并等它结束，轮收尾后的放手租约、接着取下一条与「下一句」也都等它跑完。
 *
 * 响应流结束不等于这些都做完了。不等就清库，它们会写向刚删掉的会话，撞外键、撞死锁，
 * 或者把下一个用例放进收件箱的消息当成排着的抢去开轮。
 */
beforeEach(settleAgentTailsForTesting)
