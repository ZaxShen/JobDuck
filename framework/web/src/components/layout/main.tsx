import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Main({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('px-4 py-6 @7xl/content:mx-auto @7xl/content:w-full @7xl/content:max-w-7xl', className)}
      {...props}
    />
  )
}
