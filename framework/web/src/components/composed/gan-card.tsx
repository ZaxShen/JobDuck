import type { ComponentProps } from 'react'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface GanCardProps extends ComponentProps<typeof Card> {
  variant?: 'default' | 'static'
}

function GanCard({ className, variant = 'default', ...props }: GanCardProps) {
  return (
    <Card
      className={cn(
        'border border-border bg-card transition-colors duration-150 ease-out',
        variant === 'default' && 'hover:bg-card/80',
        className,
      )}
      {...props}
    />
  )
}

export {
  GanCard,
  CardHeader as GanCardHeader,
  CardContent as GanCardContent,
  CardFooter as GanCardFooter,
  CardTitle as GanCardTitle,
  CardDescription as GanCardDescription,
  CardAction as GanCardAction,
}
