/*
 * Copyright (c) 2016 Zibin Zheng <znbin@qq.com>
 * All rights reserved
 */

#include <stdio.h>
#include "multi_timer.h"

//timer handle list head.
static struct Timer* head_handle = NULL;

//Timer ticks
//static uint32_t _timer_ticks = (1 << 32)- 1000; // only for test tick clock overflow
//static volatile  uint32_t _timer_ticks = 0;
#define _timer_ticks (CW_BTIM1->CNT)
static volatile uint32_t _timer_ticksHigh = 0;
/**
  * @brief  Initializes the timer struct handle.
  * @param  handle: the timer handle strcut.
  * @param  timeout_cb: timeout callback.
  * @param  timeout: delay to start the timer.
  * @param  repeat: repeat interval time.
  * @param  arg: the input argument for timeout_cb fucntion.
  * @retval None
  */
void timer_init(struct Timer* handle, void (*timeout_cb)(void *arg), \
      uint32_t timeout, uint32_t repeat, void *arg)
{
    // memset(handle, sizeof(struct Timer), 0);
    handle->timeout_cb          = timeout_cb;      
    handle->timeout             = timeout;
    handle->repeat              = repeat;
//    handle->cur_ticks           = _timer_ticks;  
//    handle->cur_expired_time    = handle->timeout;
    handle->arg                 = arg;
    //printf("cur_ticks: %u, cur_expired_time: %u, _timer_ticks: %u, timeout: %u\r\n", 
    //  handle->cur_ticks, handle->cur_expired_time, _timer_ticks, timeout);
}

/**
  * @brief  Start the timer work, add the handle into work list.
  * @param  btn: target handle strcut.
  * @retval 0: succeed. -1: already exist.
  */
int timer_start(struct Timer* handle)
{
    struct Timer* target = head_handle;

    while(target) {
        if(target == handle) {
            return -1;  //already exist.
        }            
        target = target->next;
    }
    handle->next = head_handle;
    handle->cur_ticks = _timer_ticks;
    handle->cur_expired_time = handle->timeout;
    head_handle  = handle;

    return 0;
}

int timer_start_timeout(struct Timer* handle,uint32_t timeout)
{
    handle->timeout = timeout;
    return timer_start(handle);
}

int timer_restart(struct Timer* handle)
{
    timer_stop(handle);
    return timer_start(handle);
}

int timer_restart_timeout(struct Timer* handle,uint32_t timeout)
{
  timer_stop(handle);
  if(timeout == 0)
  {
    if(handle->timeout_cb)
      handle->timeout_cb(handle->arg);
  }else{
    return timer_start_timeout(handle,timeout);
  }
  return 0;
}
/**
  * @brief  Stop the timer work, remove the handle off work list.
  * @param  handle: target handle strcut.
  * @retval 0: succeed. -1: timer not exist.
  */
int timer_stop(struct Timer* handle)
{
    struct Timer** curr;

    for(curr = &head_handle; *curr;) {
        struct Timer* entry = *curr;
        if(entry == handle) {
            *curr = entry->next;
            //free(entry);
            return 0; // found specified timer
        } else {
            curr = &entry->next;
        }            
    }

    return 0;
}

/**
  * @brief  main loop.
  * @param  None.
  * @retval None
  */
void timer_loop(void)
{
    struct Timer* target;

    for(target = head_handle; target; target = target->next) {
        /* 
        More detail on tick-clock overflow, please see https://blog.csdn.net/szullc/article/details/115332326
        */
         if(_timer_ticks - target->cur_ticks >= target->cur_expired_time) {
            //printf("cur_ticks: %u, cur_expired_time: %u, _timer_ticks: %u\r\n", 
            //        target->cur_ticks, target->cur_expired_time, _timer_ticks);
            if(target->repeat == 0) {
                timer_stop(target);
            } else {
                target->cur_expired_time = target->repeat;
                target->cur_ticks = _timer_ticks;
            }

            target->timeout_cb(target->arg);
/*           
 *          int16_t tempT3 = CW_BTIM3->CNT; //0~999
 *          int16_t delta_ms = _timer_ticks - target->cur_ticks;
 *          int16_t delta_us = CW_BTIM3->CNT - tempT3;
 *
 *          // 处理 BTIM3 回绕 (0~999)
 *          if (delta_us < 0) {
 *              delta_us += 1000;
 *              delta_ms -= 1;
 *          }
 *          if(delta_ms>0)
 *            target->used_ticks = delta_ms * 1000 + delta_us;
 *          else target->used_ticks = delta_us;
 */
        }
    }
}

/**
  * @brief  background ticks, timer repeat invoking interval nms.
  * @param  None.
  * @retval None.
  */
void timer_ticks(void)
{
    //_timer_ticks += CFG_TIMER_1_TICK_N_MS;
  //_timer_ticksHigh += 0x10000;
}


void BTIM1_IRQHandler(void)
{
  if (CW_BTIM1->ISR_f.UIF)
  {
    //timer_ticks();
    _timer_ticksHigh += 0x10000;
    
    CW_BTIM1->ICR = 0;
  }
}


uint32_t millis(void) {
  uint32_t high, low;
  do {
    high = _timer_ticksHigh;
    low = CW_BTIM1->CNT;
    // 如果在读low之后、再次读high之前发生了溢出，那么读到的high会变化，循环会继续
  } while (high != _timer_ticksHigh); 
  return (high | low);
}
